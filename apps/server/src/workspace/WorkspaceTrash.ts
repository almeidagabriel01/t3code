// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class WorkspaceTrashUnavailableError extends Schema.TaggedError<WorkspaceTrashUnavailableError>()(
  "WorkspaceTrashUnavailableError",
  { path: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `The trash cannot take '${this.path}': ${this.reason}`;
  }
}

export class WorkspaceTrashOperationError extends Schema.TaggedError<WorkspaceTrashOperationError>()(
  "WorkspaceTrashOperationError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Trash operation failed for '${this.path}'.`;
  }
}

export interface TrashedEntry {
  readonly trashedPath: string;
  /** The freedesktop `.trashinfo` record, removed when the entry is put back. */
  readonly infoPath: string | null;
}

/**
 * Moves entries into the user's trash by renaming them, so they can be put back.
 * macOS uses `~/.Trash`, Linux the freedesktop home trash. Other platforms and
 * entries on another volume report unavailable instead of deleting.
 */
export class WorkspaceTrash extends Context.Service<
  WorkspaceTrash,
  {
    readonly assertAvailable: (
      absolutePath: string,
    ) => Effect.Effect<void, WorkspaceTrashUnavailableError | WorkspaceTrashOperationError>;
    readonly moveToTrash: (
      absolutePath: string,
    ) => Effect.Effect<TrashedEntry, WorkspaceTrashUnavailableError | WorkspaceTrashOperationError>;
    readonly putBack: (
      entry: TrashedEntry,
      destination: string,
    ) => Effect.Effect<void, WorkspaceTrashOperationError>;
  }
>()("t3/workspace/WorkspaceTrash") {}

interface TrashLocation {
  readonly filesDir: string;
  readonly infoDir: string | null;
}

const errnoCode = (cause: unknown) => (cause as NodeJS.ErrnoException | undefined)?.code;

const trashInfo = (originalPath: string, nowMillis: number) => {
  const date = DateTime.formatIso(DateTime.makeUnsafe(nowMillis)).slice(0, 19);
  const encoded = originalPath.split("/").map(encodeURIComponent).join("/");
  return `[Trash Info]\nPath=${encoded}\nDeletionDate=${date}\n`;
};

/** @internal Exported for tests. */
export const makeAt = (location: TrashLocation | null) => {
  const unavailable = (path: string, reason: string) =>
    new WorkspaceTrashUnavailableError({ path, reason });

  const assertAvailable: WorkspaceTrash["Service"]["assertAvailable"] = Effect.fn(
    "WorkspaceTrash.assertAvailable",
  )(function* (absolutePath) {
    if (location === null) {
      return yield* unavailable(absolutePath, "this system has no supported trash");
    }
    const [entry, trash] = yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(location.filesDir, { recursive: true });
        if (location.infoDir !== null) await NodeFSP.mkdir(location.infoDir, { recursive: true });
        return Promise.all([NodeFSP.lstat(absolutePath), NodeFSP.stat(location.filesDir)]);
      },
      catch: (cause) => new WorkspaceTrashOperationError({ path: absolutePath, cause }),
    });
    // A rename cannot cross volumes, and copying out would lose what makes the trash undoable.
    if (entry.dev !== trash.dev) {
      return yield* unavailable(absolutePath, "it is on a different volume than the trash");
    }
  });

  const moveToTrash: WorkspaceTrash["Service"]["moveToTrash"] = Effect.fn(
    "WorkspaceTrash.moveToTrash",
  )(function* (absolutePath) {
    yield* assertAvailable(absolutePath);
    const { filesDir, infoDir } = location!;
    const nowMillis = yield* Clock.currentTimeMillis;
    return yield* Effect.tryPromise({
      try: async (): Promise<TrashedEntry> => {
        const parsed = NodePath.parse(NodePath.basename(absolutePath));
        for (let attempt = 0; ; attempt++) {
          const name =
            attempt === 0 ? parsed.base : `${parsed.name} ${nowMillis}-${attempt}${parsed.ext}`;
          const trashedPath = NodePath.join(filesDir, name);
          let infoPath: string | null = null;
          if (infoDir !== null) {
            infoPath = NodePath.join(infoDir, `${name}.trashinfo`);
            try {
              // Exclusive create reserves the name, as the freedesktop spec requires.
              await NodeFSP.writeFile(infoPath, trashInfo(absolutePath, nowMillis), {
                flag: "wx",
              });
            } catch (cause) {
              if (errnoCode(cause) === "EEXIST") continue;
              throw cause;
            }
          }
          const taken = await NodeFSP.lstat(trashedPath).then(
            () => true,
            () => false,
          );
          if (taken) {
            if (infoPath !== null) await NodeFSP.rm(infoPath, { force: true });
            continue;
          }
          try {
            await NodeFSP.rename(absolutePath, trashedPath);
          } catch (cause) {
            if (infoPath !== null) await NodeFSP.rm(infoPath, { force: true });
            throw cause;
          }
          return { trashedPath, infoPath };
        }
      },
      catch: (cause) => new WorkspaceTrashOperationError({ path: absolutePath, cause }),
    });
  });

  const putBack: WorkspaceTrash["Service"]["putBack"] = Effect.fn("WorkspaceTrash.putBack")(
    function* (entry, destination) {
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          await NodeFSP.rename(entry.trashedPath, destination);
          if (entry.infoPath !== null) await NodeFSP.rm(entry.infoPath, { force: true });
        },
        catch: (cause) => new WorkspaceTrashOperationError({ path: entry.trashedPath, cause }),
      });
    },
  );

  return WorkspaceTrash.of({ assertAvailable, moveToTrash, putBack });
};

// ponytail: no Windows Recycle Bin; it needs a shell call and cannot be put back. Windows deletes permanently after the warning.
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  if (platform === "darwin")
    return makeAt({ filesDir: NodePath.join(home, ".Trash"), infoDir: null });
  if (platform === "win32") return makeAt(null);
  const dataHome = env.XDG_DATA_HOME?.trim() || NodePath.join(home, ".local", "share");
  const trashRoot = NodePath.join(dataHome, "Trash");
  return makeAt({
    filesDir: NodePath.join(trashRoot, "files"),
    infoDir: NodePath.join(trashRoot, "info"),
  });
});

export const layer = Layer.effect(WorkspaceTrash, make);
