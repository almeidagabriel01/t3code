import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Config from "../config.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as NoteImages from "./NoteImages.ts";
import * as Git from "./NotesGit.ts";
import * as Notes from "./NotesService.ts";

/** Records the attachment ids the note images layer asks to delete. */
export const cleanupRecorder = (cleaned: Array<string>) =>
  Layer.mock(ResourceCleanupService.ResourceCleanupService)({
    cleanupAttachments: (ids) =>
      Effect.sync(() => {
        cleaned.push(...ids);
      }),
  });

const platformLayer = (
  transformFs: (fs: FileSystem.FileSystem) => FileSystem.FileSystem = (fs) => fs,
) =>
  Layer.provideMerge(
    Config.ServerConfig.layerTest(process.cwd(), { prefix: "t3-notes-test-" }),
    Layer.effectContext(
      Effect.gen(function* () {
        const context = yield* Layer.build(NodeServices.layer);
        return Context.add(
          context,
          FileSystem.FileSystem,
          transformFs(Context.get(context, FileSystem.FileSystem)),
        );
      }),
    ),
  );

export const notesLayer = (
  options: {
    readonly transformFs?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem;
    readonly getThread?: Projections.ProjectionStoreV2["Service"]["getThread"];
    /** Whether a project id names a project; every id does by default. */
    readonly projectExists?: (projectId: string) => boolean;
    /** Stores images for real and records the ids released through cleanup. */
    readonly cleaned?: Array<string>;
  } = {},
) =>
  Notes.layer.pipe(
    Layer.provide(
      Layer.mock(Projections.ProjectionStoreV2)({
        getThread:
          options.getThread ??
          ((threadId) =>
            Effect.fail(new Projections.ProjectionStoreThreadNotFoundError({ threadId }))),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (projectId) =>
          Effect.succeed(
            (options.projectExists?.(projectId) ?? true)
              ? Option.some({} as ProjectStore.ProjectRow)
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(Layer.succeed(Git.NotesGit, { changed: Effect.void, flush: Effect.void })),
    Layer.provideMerge(
      options.cleaned === undefined
        ? Layer.empty
        : NoteImages.layerLive.pipe(Layer.provide(cleanupRecorder(options.cleaned))),
    ),
    Layer.provideMerge(platformLayer(options.transformFs)),
  );

/** A layer whose next note write runs the armed effect just before replacing the file. */
export const racing = () => {
  let race: Effect.Effect<void> | undefined;
  return {
    arm: (effect: Effect.Effect<void>) => {
      race = effect;
    },
    layer: notesLayer({
      transformFs: (fs) => ({
        ...fs,
        makeTempDirectoryScoped: Effect.fn("NotesTestkit.racingTempDirectory")(function* (
          options?: Parameters<FileSystem.FileSystem["makeTempDirectoryScoped"]>[0],
        ) {
          const pending = options?.prefix === ".note-" ? race : undefined;
          race = undefined;
          if (pending) yield* pending;
          return yield* fs.makeTempDirectoryScoped(options);
        }),
      }),
    }),
  };
};
