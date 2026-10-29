import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  NoteDocument,
  NoteSummary,
  NotesUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useKanbanEnvironmentIds } from "../../state/kanban";
import { notesEnvironment } from "../../state/notes";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { NoteCardChip } from "./NoteCard";
import { NoteConflictDialog } from "./NoteConflictDialog";
import { NoteEditor } from "./NoteEditor";
import { NoteFileDialog } from "./NoteFileDialog";
import { NoteStartWorkDialog } from "./NoteStartWorkDialog";
import { isNoteDirty, noteErrorMessage, NoteSession, type NoteEditState } from "./noteState";
import { useNoteCommand } from "./useNoteCommand";

interface NotePaneProps {
  environmentId: EnvironmentId;
  summary: NoteSummary | undefined;
  /** False until the live list has arrived, so a missing summary means nothing yet. */
  listReady: boolean;
  autoFocus: boolean;
  onSelect: (path: string | undefined) => void;
  onExitEditor: () => void;
}

export function NoteLoader(props: NotePaneProps & { path: string }) {
  const query = useEnvironmentQuery(
    notesEnvironment.note({ environmentId: props.environmentId, input: { path: props.path } }),
  );
  const document = query.data;
  return (
    <>
      {!document && <BackToNotes className="mx-4 mt-3" />}
      {query.error && !document && (
        <div
          role="alert"
          className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-6 text-sm text-destructive-foreground md:px-8"
        >
          {query.error}
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Reload
          </Button>
        </div>
      )}
      {document ? (
        <NoteDetail {...props} document={document} />
      ) : !query.error ? (
        <p
          role="status"
          className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-6 text-sm text-muted-foreground md:px-8"
        >
          <Spinner />
          Loading note…
        </p>
      ) : null}
    </>
  );
}

function NoteDetail(props: NotePaneProps & { document: NoteDocument }) {
  const { environmentId } = props;
  const write = useNoteCommand(notesEnvironment.write);
  const read = useNoteCommand(notesEnvironment.read);
  const update = useNoteCommand(notesEnvironment.update);
  const readCurrent = useStableCallback((path: string) => read({ environmentId, input: { path } }));
  const writeCurrent = useStableCallback((input: Parameters<typeof write>[0]["input"]) =>
    write({ environmentId, input }),
  );
  // NoteLoader keys this pane by path, so a session never outlives its path.
  const [session] = useState(
    () => new NoteSession(props.document, writeCurrent, () => readCurrent(props.document.path)),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const canWrite = useAtomValue(notesEnvironment.write.permissionAtom(environmentId));
  const canMove = useAtomValue(notesEnvironment.move.permissionAtom(environmentId));
  const canDelete = useAtomValue(notesEnvironment.delete.permissionAtom(environmentId));
  const canUpdate = useAtomValue(notesEnvironment.update.permissionAtom(environmentId));
  const canStartWork = useAtomValue(notesEnvironment.startWork.permissionAtom(environmentId));
  const hasBoards = useKanbanEnvironmentIds().includes(environmentId);
  const canStart = canStartWork && hasBoards;
  const [compare, setCompare] = useState(false);
  const [fileAction, setFileAction] = useState<"move" | "delete" | null>(null);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Focus only on the first mount; an editor remounted by a reload must not take focus back.
  const [focusOnMount] = useState(props.autoFocus);
  // A note that was listed and then left the list was removed or moved elsewhere.
  const [listed, setListed] = useState(false);
  if (props.summary !== undefined && !listed) setListed(true);
  const removed = listed && props.listReady && props.summary === undefined;
  const dirty = isNoteDirty(state);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds server reads of this note into the external edit session
  useEffect(() => {
    session.receive(props.document);
  }, [session, props.document]);
  const summary = props.summary;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a newer revision in the live list means the file changed on the server; reread it
  useEffect(() => {
    if (summary && summary.revision !== session.getSnapshot().document.revision)
      void session.refresh(() => readCurrent(summary.path));
  }, [session, summary, readCurrent]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- autosave timer: writes the draft to the server after typing pauses
  useEffect(() => {
    if (
      !canWrite ||
      removed ||
      !dirty ||
      state.incoming ||
      state.saving ||
      state.error ||
      state.refreshing ||
      state.refreshError
    )
      return;
    const timeout = setTimeout(() => {
      void session.save(state.body);
    }, 600);
    return () => clearTimeout(timeout);
  }, [
    session,
    state.body,
    state.incoming,
    state.saving,
    state.error,
    state.refreshing,
    state.refreshError,
    canWrite,
    dirty,
    removed,
  ]);
  useBlocker({
    shouldBlockFn: ({ current, next }) =>
      (current.pathname !== next.pathname ||
        ("path" in current.search ? current.search.path : undefined) !==
          ("path" in next.search ? next.search.path : undefined)) &&
      (dirty || state.saving) &&
      !window.confirm(
        state.saving
          ? "A note is still saving. Leave this page?"
          : "Discard unsaved changes to this note?",
      ),
    enableBeforeUnload: dirty || state.saving,
  });

  const latest = props.summary ?? state.document;
  const fileBusy = dirty || state.saving || state.incoming !== null || removed;
  const runUpdate = async (input: Omit<NotesUpdateInput, "path">) => {
    setActionError(null);
    const result = await update({
      environmentId,
      input: { path: state.document.path, ...input },
    });
    if (result.ok) session.receive(result.value);
    else setActionError(noteErrorMessage(result.error));
  };
  const fileName = state.document.path.slice(state.document.path.lastIndexOf("/") + 1);

  return (
    <article className="flex min-w-0 flex-1 flex-col" aria-label="Selected note">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-1 md:px-8 md:pt-6">
        <BackToNotes />
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {state.document.folder ? <span>{state.document.folder} / </span> : null}
          {fileName}
        </p>
        <SaveState
          state={state}
          dirty={dirty}
          canWrite={canWrite}
          onRetry={() => void session.save()}
        />
        <div className="ms-auto flex items-center gap-1">
          {canUpdate ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    size="sm"
                    variant="ghost"
                    aria-label={latest.pinned ? "Unpin note" : "Pin note"}
                    pressed={latest.pinned}
                    disabled={removed}
                    onPressedChange={(next) => void runUpdate({ pinned: next })}
                  />
                }
              >
                {latest.pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {latest.pinned ? "Unpin" : "Pin to the top"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {canStart && latest.card === null ? (
            <Button
              size="xs"
              variant="outline"
              disabled={fileBusy}
              onClick={() => setStarting(true)}
            >
              <PlayIcon aria-hidden />
              Start work
            </Button>
          ) : null}
          {canMove || canDelete ? (
            <Menu>
              <MenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="More note actions" />}
              >
                <EllipsisIcon aria-hidden />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem disabled={!canMove || fileBusy} onClick={() => setFileAction("move")}>
                  Rename or move…
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  disabled={!canDelete || fileBusy}
                  onClick={() => setFileAction("delete")}
                >
                  Delete…
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-3xl gap-2 px-4 md:px-8">
        {latest.card !== null ? (
          <div>
            <NoteCardChip
              environmentId={environmentId}
              link={latest.card}
              canUnlink={canUpdate && !removed}
              onUnlink={() => void runUpdate({ card: null })}
            />
          </div>
        ) : null}
        {removed && (
          <p role="alert" className="text-sm text-destructive-foreground">
            This note was removed. Your draft is still visible; copy it before leaving.
          </p>
        )}
        {!canWrite && (
          <p className="text-sm text-muted-foreground">This connection has read-only access.</p>
        )}
        {state.refreshError && (
          <div role="alert" className="flex items-center gap-2 text-sm text-destructive-foreground">
            {state.refreshError}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void session.refresh(() => readCurrent(state.document.path))}
            >
              Reload note
            </Button>
          </div>
        )}
        {(state.error || actionError) && (
          <p role="alert" className="text-sm text-destructive-foreground">
            {state.error ?? actionError}
          </p>
        )}
        {state.incoming && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/32 bg-warning/8 p-3 text-sm"
          >
            <span>This note changed while you were editing. Compare before saving.</span>
            <Button size="sm" variant="outline" onClick={() => setCompare(true)}>
              Compare changes
            </Button>
          </div>
        )}
      </div>
      <NoteEditor
        key={state.editorVersion}
        environmentId={environmentId}
        body={state.body}
        editable={canWrite && !removed}
        autoFocus={focusOnMount && state.editorVersion === 0}
        claimedImages={state.claimedImages}
        onChange={(body) => session.edit(body)}
        onExit={props.onExitEditor}
      />
      {latest.related.length > 0 ? (
        <section
          aria-label="Related threads"
          className="mx-auto w-full max-w-3xl px-4 pt-4 pb-10 md:px-8"
        >
          <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Related threads</h2>
          <ul className="grid gap-px">
            {latest.related.map((threadId) => (
              <RelatedThread
                key={threadId}
                environmentId={environmentId}
                threadId={threadId}
                onUnlink={
                  canUpdate && !removed ? () => void runUpdate({ unrelate: threadId }) : undefined
                }
              />
            ))}
          </ul>
        </section>
      ) : null}
      <NoteConflictDialog
        state={state}
        open={compare}
        canWrite={canWrite && !removed}
        onOpenChange={setCompare}
        onTheirs={() => {
          session.acceptTheirs();
          setCompare(false);
        }}
        onMine={() => {
          setCompare(false);
          void session.keepMine();
        }}
      />
      {fileAction && (
        <NoteFileDialog
          environmentId={environmentId}
          action={fileAction}
          document={state.document}
          onConflict={(current) => {
            session.compare(current);
            setFileAction(null);
            setCompare(true);
          }}
          onClose={() => setFileAction(null)}
          onDone={(path) => {
            setFileAction(null);
            props.onSelect(path);
          }}
        />
      )}
      {starting && (
        <NoteStartWorkDialog
          environmentId={environmentId}
          document={state.document}
          onStarted={(note) => session.receive(note)}
          onClose={() => setStarting(false)}
        />
      )}
    </article>
  );
}

/** A thread linked to the note for reference, from that thread's Notes button. */
function RelatedThread(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onUnlink: (() => void) | undefined;
}) {
  const shell = useQuietThreadShell({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const title = shell?.title.trim() || "Thread";
  return (
    <li className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent/40">
      <MessageSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      {shell ? (
        <Link
          className="min-w-0 flex-1 truncate font-medium underline-offset-2 hover:underline"
          to="/$environmentId/$threadId"
          params={scopeThreadRef(props.environmentId, props.threadId)}
        >
          {title}
        </Link>
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          A thread that is no longer here
        </span>
      )}
      {props.onUnlink ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Unlink ${title}`}
          onClick={props.onUnlink}
        >
          <XIcon aria-hidden />
        </Button>
      ) : null}
    </li>
  );
}

/** The list and the note share the screen below md; this is the way back to the list there. */
function BackToNotes(props: { className?: string }) {
  const navigate = useNavigate();
  return (
    <div className={cn("md:hidden", props.className)}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Back to notes"
        onClick={() => void navigate({ to: "/notes", search: ({ path: _path, ...rest }) => rest })}
      >
        <ArrowLeftIcon aria-hidden />
      </Button>
    </div>
  );
}

function SaveState(props: {
  state: NoteEditState;
  dirty: boolean;
  canWrite: boolean;
  onRetry: () => void;
}) {
  const { state } = props;
  if (!props.canWrite) return null;
  const [label, tone] = state.saving
    ? ["Saving…", "text-muted-foreground"]
    : state.incoming
      ? ["Changed elsewhere", "text-warning-foreground"]
      : state.error
        ? ["Not saved", "text-destructive-foreground"]
        : props.dirty
          ? ["Unsaved", "text-muted-foreground"]
          : ["Saved", "text-muted-foreground"];
  return (
    <span role="status" className={cn("flex shrink-0 items-center gap-1 text-xs", tone)}>
      {label === "Saved" && <CheckIcon aria-hidden className="size-3" />}
      {label}
      {state.error && !state.incoming && (
        <Button size="xs" variant="ghost" onClick={props.onRetry}>
          Retry
        </Button>
      )}
    </span>
  );
}
