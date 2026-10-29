import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectNotesInOrder } from "@t3tools/client-runtime/state/notes";
import { NoteFolder, type EnvironmentId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { LinkIcon, NotebookPenIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { notesEnvironment, useNotesEnvironmentIds } from "../../state/notes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { filterNotes, noteErrorMessage } from "./noteState";
import { useNotesPanelStore } from "./notesPanelStore";
import { useCreateNote } from "./useCreateNote";
import { useNoteCommand } from "./useNoteCommand";

const isNoteFolder = Schema.is(NoteFolder);
const LINK_RESULTS = 6;

/** Notes related to a thread live on the thread's own environment, so the button needs notes there. */
export function ThreadNotesButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId | null;
  projectTitle: string | null;
}) {
  const supported = useNotesEnvironmentIds().includes(props.environmentId);
  if (!supported) return null;
  return <ThreadNotes {...props} />;
}

function ThreadNotes(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId | null;
  projectTitle: string | null;
}) {
  const { environmentId } = props;
  const state = Option.getOrNull(
    AsyncResult.value(useAtomValue(notesEnvironment.live({ environmentId, input: null }))),
  );
  const canWrite = useAtomValue(notesEnvironment.write.permissionAtom(environmentId));
  const canUpdate = useAtomValue(notesEnvironment.update.permissionAtom(environmentId));
  const update = useNoteCommand(notesEnvironment.update);
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(environmentId, props.threadId);
  const panelOpen = useRightPanelStore(
    (store) => selectActiveRightPanel(store.byThreadKey, threadRef) === "notes",
  );
  // Without a project there is no project panel; notes open on their page.
  const openNote = (path: string) => {
    if (props.projectId === null) {
      void navigate({ to: "/notes", search: { environmentId, path } });
      return;
    }
    useNotesPanelStore.getState().setPath(scopedThreadKey(threadRef), path);
    useRightPanelStore.getState().open(threadRef, "notes");
  };
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const notes = state === null ? [] : selectNotesInOrder(state);
  const createNote = useCreateNote(environmentId, notes);
  if (state === null || (notes.length === 0 && !canWrite)) return null;
  const linked = notes.filter((note) => note.related.includes(props.threadId));
  const suggestions = filterNotes(
    notes.filter((note) => !note.related.includes(props.threadId)),
    query,
  ).slice(0, LINK_RESULTS);
  const relate = async (path: string, change: "relate" | "unrelate") => {
    setError(null);
    const result = await update({ environmentId, input: { path, [change]: props.threadId } });
    if (result.ok) return null;
    const message = noteErrorMessage(result.error);
    setError(message);
    return message;
  };
  const createForThread = async () => {
    setError(null);
    const folder =
      props.projectTitle && isNoteFolder(props.projectTitle) ? props.projectTitle : null;
    const created = await createNote(folder, props.projectId ?? undefined);
    if (!created.ok) {
      setError(noteErrorMessage(created.error));
      return;
    }
    if (canUpdate) {
      const failure = await relate(created.value.path, "relate");
      // The note exists either way; it stays in the list below so linking can be retried.
      if (failure) {
        setError(`Created ${created.value.path}, but it is not linked yet. ${failure}`);
        return;
      }
    }
    setOpen(false);
    openNote(created.value.path);
  };
  const label =
    linked.length === 0
      ? "Notes for this thread"
      : `Notes for this thread (${linked.length} linked)`;
  const panelToggle =
    props.projectId === null ? null : (
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={panelOpen}
            onPressedChange={() => useRightPanelStore.getState().toggle(threadRef, "notes")}
            aria-label="Toggle project notes"
            variant="ghost"
            size="sm"
          >
            <NotebookPenIcon className="size-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Project notes</TooltipPopup>
      </Tooltip>
    );
  return (
    <>
      {panelToggle}
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Toggle
                  className="shrink-0 [-webkit-app-region:no-drag]"
                  pressed={open}
                  aria-label={label}
                  variant="ghost"
                  size="sm"
                />
              }
            />
          }
        >
          {panelToggle ? <LinkIcon className="size-4" /> : <NotebookPenIcon className="size-4" />}
          {linked.length > 0 ? (
            <span className="text-xs text-muted-foreground tabular-nums">{linked.length}</span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup width="md" align="end">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <PopoverTitle>Notes for this thread</PopoverTitle>
          {linked.length === 0 ? (
            <p className="text-sm text-muted-foreground">No notes linked to this thread yet.</p>
          ) : (
            <ul className="-mx-2 grid grid-cols-[minmax(0,1fr)] gap-px" aria-label="Linked notes">
              {linked.map((note) => (
                <li
                  key={note.path}
                  className="flex items-start gap-1 rounded-md hover:bg-accent/50"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      openNote(note.path);
                    }}
                    className="grid min-w-0 flex-1 gap-0.5 rounded-md text-start px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <span className="truncate text-sm font-medium">{note.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {note.preview || note.path}
                    </span>
                  </button>
                  {canUpdate ? (
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      className="mt-1.5 me-1"
                      aria-label={`Unlink ${note.title}`}
                      onClick={() => void relate(note.path, "unrelate")}
                    >
                      <XIcon aria-hidden />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canUpdate && notes.length > linked.length ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
              <Input
                size="sm"
                type="search"
                aria-label="Find a note to link"
                placeholder="Link a note…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <ul
                className="-mx-2 grid grid-cols-[minmax(0,1fr)] gap-px"
                aria-label="Notes to link"
              >
                {suggestions.map((note) => (
                  <li key={note.path}>
                    <button
                      type="button"
                      onClick={() => void relate(note.path, "relate")}
                      className="w-full truncate rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      {note.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {canWrite ? (
            <Button size="sm" variant="outline" onClick={() => void createForThread()}>
              <PlusIcon aria-hidden />
              New note for this thread
            </Button>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
    </>
  );
}
