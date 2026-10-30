import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { selectNotesInOrder } from "@t3tools/client-runtime/state/notes";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { notesEnvironment } from "../../state/notes";
import { Spinner } from "../ui/spinner";
import { NoteLoader } from "./NoteDetail";
import { NoteList } from "./NoteList";
import { noteErrorMessage } from "./noteState";
import { useNotesPanelStore } from "./notesPanelStore";
import { useCreateNote } from "./useCreateNote";

export interface NotesSurfaceProps {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
}

/** The thread's project notes: the list, or one note's editor with a way back to the list. */
export function NotesSurface({ threadRef, projectId }: NotesSurfaceProps) {
  const { environmentId } = threadRef;
  const threadKey = scopedThreadKey(threadRef);
  const path = useNotesPanelStore((state) => state.pathByThreadKey[threadKey]);
  const setPath = useNotesPanelStore((state) => state.setPath);
  const live = useAtomValue(notesEnvironment.live({ environmentId, input: null }));
  const canCreate = useAtomValue(notesEnvironment.write.permissionAtom(environmentId));
  const [query, setQuery] = useState("");
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const state = Option.getOrNull(AsyncResult.value(live));
  const allNotes = state === null ? [] : selectNotesInOrder(state);
  const notes = allNotes.filter((note) => note.project === projectId);
  const createNote = useCreateNote(environmentId, allNotes);
  const select = (next: string | undefined) => {
    setFocusPath(null);
    setPath(threadKey, next);
  };
  const create = () => {
    setCreateError(null);
    void createNote(null, projectId).then((result) => {
      if (result.ok) {
        setFocusPath(result.value.path);
        setPath(threadKey, result.value.path);
      } else setCreateError(noteErrorMessage(result.error));
    });
  };
  if (path) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <NoteLoader
          key={path}
          environmentId={environmentId}
          path={path}
          summary={state?.notes.get(path)}
          listReady={state !== null && !state.truncated}
          autoFocus={path === focusPath}
          onSelect={select}
          onExitEditor={() => undefined}
          onBack={() => select(undefined)}
        />
      </div>
    );
  }
  return (
    <NoteList
      environmentId={environmentId}
      className="h-full"
      notes={notes}
      folders={[]}
      selectedPath={undefined}
      query={query}
      onQueryChange={setQuery}
      onSelect={select}
      onOpenEditor={(next) => setFocusPath(next)}
      onCreate={canCreate ? create : null}
      createShortcut={null}
    >
      {live._tag === "Failure" ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive-foreground">
          Could not load notes.
        </p>
      ) : null}
      {state === null && live._tag !== "Failure" ? (
        <p
          role="status"
          className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
        >
          <Spinner />
          Loading notes…
        </p>
      ) : null}
      {state !== null && notes.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">No notes in this project yet.</p>
      ) : null}
      {createError ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive-foreground">
          Couldn’t create a note. {createError}
        </p>
      ) : null}
    </NoteList>
  );
}
