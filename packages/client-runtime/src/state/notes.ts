import {
  WS_METHODS,
  type NoteFolder,
  type NotePath,
  type NotesEvent,
  type NoteSummary,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export interface NotesState {
  readonly notes: ReadonlyMap<NotePath, NoteSummary>;
  readonly folders: ReadonlyArray<NoteFolder>;
  /** True when the server holds more notes than its snapshot sent. */
  readonly truncated: boolean;
}

/** Folds one event; the first is always a snapshot, so state starts from it. */
export function applyNotesEvent(state: NotesState | null, event: NotesEvent): NotesState | null {
  if (event.type === "snapshot") {
    return {
      notes: new Map(event.notes.map((note) => [note.path, note])),
      folders: event.folders,
      truncated: event.truncated,
    };
  }
  if (state === null) return null;
  const notes = new Map(state.notes);
  if (event.type === "removed") {
    notes.delete(event.path);
    return { ...state, notes };
  }
  notes.set(event.note.path, event.note);
  const folder = event.note.folder;
  return {
    ...state,
    notes,
    folders:
      folder === null || state.folders.includes(folder)
        ? state.folders
        : [...state.folders, folder].sort(),
  };
}

/** Pinned first, then most recently updated. */
export function selectNotesInOrder(state: NotesState): ReadonlyArray<NoteSummary> {
  return [...state.notes.values()].sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.path.localeCompare(right.path),
  );
}

export function notesStateStream<E, R>(
  events: Stream.Stream<NotesEvent, E, R>,
): Stream.Stream<NotesState, E, R> {
  return events.pipe(
    Stream.scan((): NotesState | null => null, applyNotesEvent),
    Stream.filter((state): state is NotesState => state !== null),
  );
}

/** @public */
export function createNotesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One lane per environment keeps saves applied in the order the user made them.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial",
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  } as const;
  const command = <
    TTag extends
      | typeof WS_METHODS.notesWrite
      | typeof WS_METHODS.notesUpdate
      | typeof WS_METHODS.notesMove
      | typeof WS_METHODS.notesDelete
      | typeof WS_METHODS.notesStartWork,
  >(
    tag: TTag,
    name: string,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:notes:${name}`,
      tag,
      scheduler,
      concurrency,
    });
  return {
    live: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:notes:live",
      subscribe: (_input: null) => notesStateStream(subscribe(WS_METHODS.notesSubscribe, {})),
    }),
    note: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:notes:note",
      tag: WS_METHODS.notesRead,
      idleTtlMs: 0,
    }),
    write: command(WS_METHODS.notesWrite, "write"),
    update: command(WS_METHODS.notesUpdate, "update"),
    move: command(WS_METHODS.notesMove, "move"),
    delete: command(WS_METHODS.notesDelete, "delete"),
    startWork: command(WS_METHODS.notesStartWork, "start-work"),
  };
}
