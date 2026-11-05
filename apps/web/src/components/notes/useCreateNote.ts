import { projectNoteFolder, untitledNotePath } from "@t3tools/client-runtime/notes/title";
import type { EnvironmentId, NoteDocument, NoteSummary, ProjectId } from "@t3tools/contracts";
import { useRef } from "react";

import { useProjects } from "../../state/entities";
import { notesEnvironment } from "../../state/notes";
import { isNoteErrorReason, type NoteReply } from "./noteState";
import { useNoteCommand } from "./useNoteCommand";

/**
 * Creates Untitled.md (or the next free Untitled N.md) at once, so capture never starts with a
 * file name: in the project's folder for a project note, at the root for an unscoped one.
 * Concurrent calls share the one in flight; the guard clears when it settles so the next New note
 * works and a failure can be retried. `notes` must be every note, so taken names are skipped.
 */
export function useCreateNote(environmentId: EnvironmentId, notes: ReadonlyArray<NoteSummary>) {
  const write = useNoteCommand(notesEnvironment.write);
  const inFlight = useRef<Promise<NoteReply<NoteDocument>> | null>(null);
  const projects = useProjects();
  const taken = new Set(notes.map((note) => note.path));
  return (project?: ProjectId): Promise<NoteReply<NoteDocument>> => {
    if (inFlight.current) return inFlight.current;
    const owner = projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === project,
    );
    const folder = owner && !owner.isScratch ? projectNoteFolder(owner.title) : null;
    const attempt = async (): Promise<NoteReply<NoteDocument>> => {
      let result: NoteReply<NoteDocument> = { ok: false, error: null };
      // The list can lag another client's create by a moment; step past names taken since.
      for (let skip = 0; skip < 5; skip++) {
        result = await write({
          environmentId,
          input: {
            path: untitledNotePath(taken, folder, skip),
            body: "",
            baseRevision: null,
            ...(project === undefined ? {} : { project }),
          },
        });
        if (result.ok || !isNoteErrorReason(result.error, "exists")) return result;
      }
      return result;
    };
    const pending = attempt().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = pending;
    return pending;
  };
}
