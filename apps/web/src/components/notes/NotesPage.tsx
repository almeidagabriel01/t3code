import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { selectNotesInOrder } from "@t3tools/client-runtime/state/notes";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { NotebookPenIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useStableCallback } from "../../hooks/useStableCallback";
import { matchesPageCommand, pageCommandShortcutLabel } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import type { NotesSearch } from "../../routes/_chat.notes";
import { registerCommands } from "../../shortcuts/dispatcher";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { notesEnvironment, useNotesEnvironmentIds } from "../../state/notes";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { OptionSelect } from "../kanban/kanbanDialogs";
import { WorkspaceBreadcrumb } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { NoteLoader } from "./NoteDetail";
import { NoteList } from "./NoteList";
import { noteErrorMessage } from "./noteState";
import { useCreateNote } from "./useCreateNote";

const notesCount = (count: number) => `${count} ${count === 1 ? "note" : "notes"}`;

/** The environment a page shows: the one in the URL, else the primary, else the first. */
function pickEnvironment(
  ids: ReadonlyArray<EnvironmentId>,
  requested: string | undefined,
  primary: EnvironmentId | null,
): EnvironmentId | null {
  return ids.find((id) => id === requested) ?? ids.find((id) => id === primary) ?? ids[0] ?? null;
}

export function NotesPage(props: NotesSearch) {
  const ids = useNotesEnvironmentIds();
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const environmentId = pickEnvironment(ids, props.environmentId, primary);
  const environmentOptions = ids.map((id) => ({
    value: id,
    label: environments.find((environment) => environment.environmentId === id)?.label ?? id,
  }));
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader
        electron={isElectron}
        className="relative bg-background"
        data-glass-layer
      >
        <WorkspaceBreadcrumb ariaLabel="Notes">
          <h1 className="truncate">Notes</h1>
          {environmentId !== null ? <NotesSummary environmentId={environmentId} /> : null}
        </WorkspaceBreadcrumb>
        {environmentOptions.length > 1 && environmentId !== null ? (
          <div className="ms-auto">
            <OptionSelect
              label="Environment"
              value={environmentId}
              options={environmentOptions}
              onChange={(next) => void navigate({ to: "/notes", search: { environmentId: next } })}
            />
          </div>
        ) : null}
      </WorkspacePageHeader>
      {environmentId === null ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Notes are not available</EmptyTitle>
            <EmptyDescription>
              Connect to a T3 Code server that supports notes, with permission to read them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <EnvironmentNotes key={environmentId} {...props} environmentId={environmentId} />
      )}
    </SidebarInset>
  );
}

function NotesSummary(props: { environmentId: EnvironmentId }) {
  const state = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(notesEnvironment.live({ environmentId: props.environmentId, input: null })),
    ),
  );
  if (state === null) return null;
  return (
    <span className="truncate text-xs font-normal text-muted-foreground">
      {notesCount(state.notes.size)}
      {state.truncated ? "+" : ""}
    </span>
  );
}

function focusNoteEditor(): boolean {
  const editor = document.querySelector<HTMLElement>("[data-note-editor] [contenteditable=true]");
  editor?.focus();
  return editor !== null;
}

const rowFor = (path: string) =>
  document.querySelector<HTMLElement>(`[data-note-row="${CSS.escape(path)}"]`);
const focusSearch = () => document.querySelector<HTMLInputElement>("[data-notes-search]")?.focus();

function EnvironmentNotes(props: NotesSearch & { environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const liveAtom = notesEnvironment.live({ environmentId, input: null });
  const live = useAtomValue(liveAtom);
  const reconnect = useAtomRefresh(liveAtom);
  const canCreate = useAtomValue(notesEnvironment.write.permissionAtom(environmentId));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const [query, setQuery] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // The note whose editor takes focus when it mounts: a new note, or one opened with Enter
  // before its body loaded.
  const [focusPath, setFocusPath] = useState<string | null>(null);
  // The row to focus once the list is visible again, after Escape on a narrow screen.
  const returnTo = useRef<string | null>(null);
  const state = Option.getOrNull(AsyncResult.value(live));
  const ready = state !== null;
  const notes = state === null ? [] : selectNotesInOrder(state);
  const createNote = useCreateNote(environmentId, notes);
  const select = (path: string | undefined, options?: { replace?: boolean }) => {
    // Picking the open note again retries a read that failed.
    if (path && path === props.path)
      registry.refresh(notesEnvironment.note({ environmentId, input: { path } }));
    setFocusPath(null);
    void navigate({
      to: "/notes",
      search: { environmentId, ...(path ? { path } : {}) },
      replace: options?.replace === true,
    });
  };
  const create = useStableCallback(() => {
    if (!canCreate) return;
    setCreateError(null);
    void createNote().then((result) => {
      if (result.ok) {
        setFocusPath(result.value.path);
        void navigate({
          to: "/notes",
          search: { environmentId, path: result.value.path },
          replace: props.create === true,
        });
      } else {
        setCreateError(noteErrorMessage(result.error));
        if (props.create) void navigate({ to: "/notes", search: { environmentId }, replace: true });
      }
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the palette asks for a note through ?create; it waits for the list so the Untitled name is picked against what exists
  useEffect(() => {
    if (!props.create || !ready) return;
    if (canCreate) create();
    else void navigate({ to: "/notes", search: { environmentId }, replace: true });
  }, [props.create, ready, canCreate, create, navigate, environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the page's keys with the app-wide shortcut dispatcher while mounted
  useEffect(
    () =>
      registerCommands(
        {},
        {
          // Capture runs before the app-wide new-thread handler, which shares mod+n by default.
          capture: true,
          when: () => !isCommandPaletteOpen(),
          onKeyDown: (event) => {
            if (
              matchesPageCommand(event, keybindings, "notes.new", {
                context: {
                  notesPageOpen: true,
                  terminalFocus: isTerminalFocused(),
                  editableFocus: isEditableFocused(event.target),
                },
              })
            ) {
              event.preventDefault();
              event.stopPropagation();
              create();
              return true;
            }
            if (
              event.key === "/" &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !isEditableFocused(event.target)
            ) {
              event.preventDefault();
              focusSearch();
              return true;
            }
            return false;
          },
        },
      ),
    [keybindings, create],
  );
  const createShortcut = pageCommandShortcutLabel(keybindings, "notes.new", {
    context: { notesPageOpen: true },
  });
  const openEditor = (path: string) => {
    if (path === props.path && focusNoteEditor()) return;
    setFocusPath(path);
  };
  const exitEditor = () => {
    const path = props.path;
    if (!path) return;
    const row = rowFor(path);
    const listHidden =
      document.querySelector<HTMLElement>("nav[aria-label=Notes]")?.offsetParent === null;
    if (listHidden) {
      returnTo.current = path;
      void navigate({ to: "/notes", search: { environmentId } });
    } else if (row) row.focus();
    else focusSearch();
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus back to the list row once the narrow-screen list is shown again
  useEffect(() => {
    if (props.path || returnTo.current === null) return;
    const row = rowFor(returnTo.current);
    returnTo.current = null;
    if (row) row.focus();
    else focusSearch();
  }, [props.path]);
  const empty = ready && notes.length === 0;
  const emptyState = (
    <NotesEmpty
      kind={empty ? "none" : "unselected"}
      canCreate={canCreate}
      shortcut={createShortcut}
      onCreate={create}
    />
  );
  return (
    <div className="flex min-h-0 flex-1">
      <NoteList
        notes={notes}
        folders={state?.folders ?? []}
        selectedPath={props.path}
        query={query}
        onQueryChange={setQuery}
        onSelect={select}
        onOpenEditor={openEditor}
        onCreate={canCreate ? create : null}
        createShortcut={createShortcut}
        className={
          props.path
            ? "w-full shrink-0 max-md:hidden md:w-80 md:border-e md:border-border/60"
            : "w-full shrink-0 md:w-80 md:border-e md:border-border/60"
        }
      >
        {live._tag === "Failure" ? (
          <div role="alert" className="grid gap-2 px-3 py-2 text-sm text-destructive-foreground">
            Could not load notes.
            <Button size="sm" variant="outline" onClick={reconnect}>
              Reconnect
            </Button>
          </div>
        ) : null}
        {!ready && live._tag !== "Failure" ? (
          <p
            role="status"
            className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
          >
            <Spinner />
            Loading notes…
          </p>
        ) : null}
        {createError ? (
          <div role="alert" className="grid gap-2 px-3 py-2 text-sm text-destructive-foreground">
            Couldn’t create a note. {createError}
            <Button size="sm" variant="outline" onClick={create}>
              Try again
            </Button>
          </div>
        ) : null}
        {empty ? <div className="md:hidden">{emptyState}</div> : null}
        {state?.truncated ? (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            Showing the notes that fit in one list. Type a path such as folder/note.md to open
            another.
          </p>
        ) : null}
      </NoteList>
      <main
        className={
          props.path
            ? "flex min-w-0 flex-1 flex-col overflow-y-auto"
            : "flex min-w-0 flex-1 flex-col overflow-y-auto max-md:hidden"
        }
      >
        {props.path ? (
          <NoteLoader
            key={props.path}
            environmentId={environmentId}
            path={props.path}
            summary={state?.notes.get(props.path)}
            listReady={state !== null && !state.truncated}
            autoFocus={props.path === focusPath}
            onSelect={select}
            onExitEditor={exitEditor}
          />
        ) : ready ? (
          emptyState
        ) : null}
      </main>
    </div>
  );
}

function NotesEmpty(props: {
  kind: "none" | "unselected";
  canCreate: boolean;
  shortcut: string | null;
  onCreate: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <NotebookPenIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{props.kind === "none" ? "No notes yet" : "No note open"}</EmptyTitle>
        <EmptyDescription>
          {props.kind === "none"
            ? "Capture plans, checklists, and screenshots as markdown files. You and your agents can both read and edit them."
            : "Pick a note from the list, or start a new one."}
        </EmptyDescription>
      </EmptyHeader>
      {props.canCreate ? (
        <EmptyContent>
          <Button onClick={props.onCreate}>
            New note
            {props.shortcut ? <Kbd className="ms-1">{props.shortcut}</Kbd> : null}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
