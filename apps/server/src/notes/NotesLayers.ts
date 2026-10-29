import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as NoteImages from "./NoteImages.ts";
import * as NotesGit from "./NotesGit.ts";
import * as Notes from "./NotesService.ts";
import * as Work from "./NoteWorkService.ts";

export const layer = Work.layer.pipe(
  // update checks that a related thread exists.
  Layer.provideMerge(Notes.layer.pipe(Layer.provide(Projections.layer))),
  Layer.provideMerge(NoteImages.layerLive),
  Layer.provide(NotesGit.layer.pipe(Layer.provide(ProcessRunner.layer))),
);
