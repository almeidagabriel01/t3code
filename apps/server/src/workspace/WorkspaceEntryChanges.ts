// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  PROJECT_ENTRY_IMPORT_MAX_BYTES,
  type ProjectChangeEntryInput,
  type ProjectChangeEntryResult,
  type ProjectChangedEntry,
  ProjectEntryChangeFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import { isInGitMetadata } from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceTrash from "./WorkspaceTrash.ts";

export class WorkspaceEntryChangeError extends Schema.TaggedError<WorkspaceEntryChangeError>()(
  "WorkspaceEntryChangeError",
  {
    failure: ProjectEntryChangeFailure,
    relativePath: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isEntryChangeError = Schema.is(WorkspaceEntryChangeError);

export class WorkspaceEntryChanges extends Context.Service<
  WorkspaceEntryChanges,
  {
    /** Creates, moves, duplicates, trashes and restores entries inside a known workspace only. */
    readonly changeEntry: (
      input: ProjectChangeEntryInput,
    ) => Effect.Effect<ProjectChangeEntryResult, WorkspaceEntryChangeError>;
  }
>()("t3/workspace/WorkspaceEntryChanges") {}

interface ResolvedEntry {
  readonly relativePath: string;
  /** The real parent joined with the leaf as named: the leaf itself is never followed. */
  readonly absolutePath: string;
}

interface RestoreRecord {
  readonly root: string;
  readonly relativePath: string;
  readonly entry: WorkspaceTrash.TrashedEntry;
}

const MAX_RESTORE_RECORDS = 2_000;
const MAX_COPY_SUFFIX = 1_000;

const errnoCode = (cause: unknown) => (cause as NodeJS.ErrnoException | undefined)?.code;

const lstatOrNull = (absolutePath: string) =>
  NodeFSP.lstat(absolutePath).catch((cause: unknown) => {
    if (errnoCode(cause) === "ENOENT" || errnoCode(cause) === "ENOTDIR") return null;
    throw cause;
  });

/** `report.ts` → `report copy.ts`, `report copy 2.ts`; folders and dotfiles keep the whole name. */
export const copyName = (name: string, isDirectory: boolean, index: number) => {
  const dot = name.lastIndexOf(".");
  const split = !isDirectory && dot > 0;
  const stem = split ? name.slice(0, dot) : name;
  const extension = split ? name.slice(dot) : "";
  return `${stem} copy${index > 1 ? ` ${index}` : ""}${extension}`;
};

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const trash = yield* WorkspaceTrash.WorkspaceTrash;
  const restoreRecords = new Map<string, RestoreRecord>();

  const fail = (failure: ProjectEntryChangeFailure, relativePath: string, message: string) =>
    new WorkspaceEntryChangeError({ failure, relativePath, message });

  const attempt = <A>(relativePath: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => {
        if (isEntryChangeError(cause)) return cause;
        const code = errnoCode(cause);
        if (code === "EEXIST" || code === "ENOTEMPTY") {
          return new WorkspaceEntryChangeError({
            failure: "already_exists",
            relativePath,
            message: `'${relativePath}' already exists.`,
            cause,
          });
        }
        if (code === "ENOENT") {
          return new WorkspaceEntryChangeError({
            failure: "not_found",
            relativePath,
            message: `'${relativePath}' does not exist.`,
            cause,
          });
        }
        return new WorkspaceEntryChangeError({
          failure: "operation_failed",
          relativePath,
          message: cause instanceof Error ? cause.message : `Could not change '${relativePath}'.`,
          cause,
        });
      },
    });

  const isInside = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  };

  const resolveEntry = Effect.fn("WorkspaceEntryChanges.resolveEntry")(function* (
    cwd: string,
    relativePath: string,
  ) {
    const outside = fail("outside_root", relativePath, `'${relativePath}' is outside the project.`);
    if (relativePath.split(/[\\/]/).includes("..")) return yield* outside;
    const target = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: cwd, relativePath })
      .pipe(Effect.mapError(() => outside));
    const root = path.resolve(cwd);
    const segments = path.relative(root, target.absolutePath).split(path.sep);
    const leaf = segments.at(-1)!;
    const resolved = yield* attempt(relativePath, async () => {
      const realRoot = await NodeFSP.realpath(root);
      const parents = segments.slice(0, -1);
      for (let depth = parents.length; depth >= 0; depth--) {
        const candidate = path.join(realRoot, ...parents.slice(0, depth));
        try {
          const realParent = path.join(await NodeFSP.realpath(candidate), ...parents.slice(depth));
          return { realRoot, absolutePath: path.join(realParent, leaf), realParent };
        } catch (cause) {
          // A missing folder is created later; one that exists but cannot resolve is a dangling link.
          if (errnoCode(cause) !== "ENOENT" || (await lstatOrNull(candidate)) !== null) throw cause;
        }
      }
      throw new Error("unreachable");
    });
    if (!isInside(resolved.realRoot, resolved.realParent)) return yield* outside;
    const namedPath = path.join(resolved.realRoot, ...segments);
    const inGit = yield* attempt(
      relativePath,
      async () =>
        (await isInGitMetadata(path, resolved.absolutePath)) ||
        (await isInGitMetadata(path, namedPath)),
    );
    if (inGit) {
      return yield* fail("invalid_target", relativePath, "Git metadata cannot be changed here.");
    }
    return { relativePath: target.relativePath, absolutePath: resolved.absolutePath };
  });

  const requireAbsent = Effect.fn("WorkspaceEntryChanges.requireAbsent")(function* (
    entry: ResolvedEntry,
  ) {
    const existing = yield* attempt(entry.relativePath, () => lstatOrNull(entry.absolutePath));
    if (existing !== null) {
      return yield* fail(
        "already_exists",
        entry.relativePath,
        `'${entry.relativePath}' already exists.`,
      );
    }
  });

  /** Picks the first free `name copy N` sibling, or the name itself when `keepFirst` and free. */
  const freeSibling = Effect.fn("WorkspaceEntryChanges.freeSibling")(function* (
    cwd: string,
    relativePath: string,
    isDirectory: boolean,
    keepFirst: boolean,
  ) {
    const slash = relativePath.lastIndexOf("/");
    const parent = slash < 0 ? "" : relativePath.slice(0, slash + 1);
    const name = relativePath.slice(slash + 1);
    for (let index = keepFirst ? 0 : 1; index <= MAX_COPY_SUFFIX; index++) {
      const candidate = yield* resolveEntry(
        cwd,
        `${parent}${index === 0 ? name : copyName(name, isDirectory, index)}`,
      );
      if (
        (yield* attempt(candidate.relativePath, () => lstatOrNull(candidate.absolutePath))) === null
      )
        return candidate;
    }
    return yield* fail("already_exists", relativePath, `No free name is left for '${name}'.`);
  });

  const createEntry = Effect.fn("WorkspaceEntryChanges.create")(function* (
    cwd: string,
    relativePath: string,
    kind: "file" | "directory",
  ) {
    const entry = yield* resolveEntry(cwd, relativePath);
    yield* attempt(entry.relativePath, async () => {
      await NodeFSP.mkdir(path.dirname(entry.absolutePath), { recursive: true });
      if (kind === "directory") {
        await NodeFSP.mkdir(entry.absolutePath);
        return;
      }
      // Exclusive create never replaces a file or follows a link that appeared after the checks.
      const handle = await NodeFSP.open(
        entry.absolutePath,
        NodeFS.constants.O_WRONLY |
          NodeFS.constants.O_CREAT |
          NodeFS.constants.O_EXCL |
          (NodeFS.constants.O_NOFOLLOW ?? 0),
      );
      await handle.close();
    });
    return [{ relativePath: entry.relativePath }];
  });

  const importEntry = Effect.fn("WorkspaceEntryChanges.import")(function* (
    cwd: string,
    relativePath: string,
    contentsBase64: string,
  ) {
    const bytes = Buffer.from(contentsBase64, "base64");
    if (bytes.byteLength > PROJECT_ENTRY_IMPORT_MAX_BYTES) {
      return yield* fail("too_large", relativePath, `'${relativePath}' is larger than 25 MB.`);
    }
    for (let tries = 0; ; tries++) {
      const entry = yield* freeSibling(cwd, relativePath, false, true);
      const written = yield* attempt(entry.relativePath, async () => {
        await NodeFSP.mkdir(path.dirname(entry.absolutePath), { recursive: true });
        try {
          await NodeFSP.writeFile(entry.absolutePath, bytes, {
            flag:
              NodeFS.constants.O_WRONLY |
              NodeFS.constants.O_CREAT |
              NodeFS.constants.O_EXCL |
              (NodeFS.constants.O_NOFOLLOW ?? 0),
          });
          return true;
        } catch (cause) {
          // Another writer took the name between the check and the write; pick the next one.
          if (errnoCode(cause) === "EEXIST" && tries < 3) return false;
          throw cause;
        }
      });
      if (written) return [{ relativePath: entry.relativePath }];
    }
  });

  const moveEntry = Effect.fn("WorkspaceEntryChanges.move")(function* (
    cwd: string,
    relativePath: string,
    newRelativePath: string,
  ) {
    const source = yield* resolveEntry(cwd, relativePath);
    const destination = yield* resolveEntry(cwd, newRelativePath);
    const [sourceStat, destinationStat] = yield* attempt(relativePath, () =>
      Promise.all([lstatOrNull(source.absolutePath), lstatOrNull(destination.absolutePath)]),
    );
    if (sourceStat === null) {
      // A retried move that already landed reports the same result.
      if (destinationStat !== null) return [{ relativePath: destination.relativePath }];
      return yield* fail("not_found", relativePath, `'${relativePath}' does not exist.`);
    }
    if (
      destination.absolutePath === source.absolutePath ||
      destination.absolutePath.startsWith(`${source.absolutePath}${path.sep}`)
    ) {
      return yield* fail("invalid_target", newRelativePath, "A folder cannot move into itself.");
    }
    // Case-only renames on case-insensitive volumes see the source under the new name.
    const sameEntry =
      destinationStat !== null &&
      destinationStat.ino === sourceStat.ino &&
      destinationStat.dev === sourceStat.dev;
    if (destinationStat !== null && !sameEntry) {
      return yield* fail("already_exists", newRelativePath, `'${newRelativePath}' already exists.`);
    }
    yield* attempt(newRelativePath, async () => {
      await NodeFSP.mkdir(path.dirname(destination.absolutePath), { recursive: true });
      await NodeFSP.rename(source.absolutePath, destination.absolutePath);
    });
    return [{ relativePath: destination.relativePath }];
  });

  const duplicateEntry = Effect.fn("WorkspaceEntryChanges.duplicate")(function* (
    cwd: string,
    relativePath: string,
  ) {
    const source = yield* resolveEntry(cwd, relativePath);
    const sourceStat = yield* attempt(relativePath, () => lstatOrNull(source.absolutePath));
    if (sourceStat === null) {
      return yield* fail("not_found", relativePath, `'${relativePath}' does not exist.`);
    }
    const destination = yield* freeSibling(
      cwd,
      source.relativePath,
      sourceStat.isDirectory(),
      false,
    );
    // Links are copied as links, never followed.
    yield* attempt(destination.relativePath, () =>
      NodeFSP.cp(source.absolutePath, destination.absolutePath, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      }),
    );
    return [{ relativePath: destination.relativePath }];
  });

  const deleteEntries = Effect.fn("WorkspaceEntryChanges.delete")(function* (
    cwd: string,
    relativePaths: readonly string[],
    mode: "trash" | "permanent",
  ) {
    // Validate every path before touching any.
    const resolved = yield* Effect.forEach(relativePaths, (relativePath) =>
      resolveEntry(cwd, relativePath),
    );
    const existing: ResolvedEntry[] = [];
    for (const [index, entry] of resolved.entries()) {
      // A selected child goes with its selected folder; a missing entry is already gone.
      const covered = resolved.some(
        (other, otherIndex) =>
          entry.absolutePath.startsWith(`${other.absolutePath}${path.sep}`) ||
          (entry.absolutePath === other.absolutePath && otherIndex < index),
      );
      if (covered) continue;
      if ((yield* attempt(entry.relativePath, () => lstatOrNull(entry.absolutePath))) !== null)
        existing.push(entry);
    }
    if (mode === "trash") {
      yield* Effect.forEach(existing, (entry) =>
        trash.assertAvailable(entry.absolutePath).pipe(
          Effect.mapError((cause) =>
            cause._tag === "WorkspaceTrashUnavailableError"
              ? new WorkspaceEntryChangeError({
                  failure: "trash_unavailable",
                  relativePath: entry.relativePath,
                  message: cause.message,
                  cause,
                })
              : new WorkspaceEntryChangeError({
                  failure: "operation_failed",
                  relativePath: entry.relativePath,
                  message: cause.message,
                  cause,
                }),
          ),
        ),
      );
    }
    const entries: ProjectChangedEntry[] = [];
    const failures: { relativePath: string; message: string }[] = [];
    for (const entry of existing) {
      if (mode === "permanent") {
        // rm unlinks a link instead of following it, inside folders too.
        const removed = yield* attempt(entry.relativePath, () =>
          NodeFSP.rm(entry.absolutePath, { recursive: true, force: false }),
        ).pipe(Effect.result);
        if (removed._tag === "Success") entries.push({ relativePath: entry.relativePath });
        else failures.push({ relativePath: entry.relativePath, message: removed.failure.message });
        continue;
      }
      const trashed = yield* trash.moveToTrash(entry.absolutePath).pipe(Effect.result);
      if (trashed._tag === "Failure") {
        failures.push({ relativePath: entry.relativePath, message: trashed.failure.message });
        continue;
      }
      const restoreToken = NodeCrypto.randomUUID();
      if (restoreRecords.size >= MAX_RESTORE_RECORDS) {
        restoreRecords.delete(restoreRecords.keys().next().value!);
      }
      restoreRecords.set(restoreToken, {
        root: path.resolve(cwd),
        relativePath: entry.relativePath,
        entry: trashed.success,
      });
      entries.push({ relativePath: entry.relativePath, restoreToken });
    }
    return { entries, failures };
  });

  const restoreEntries = Effect.fn("WorkspaceEntryChanges.restore")(function* (
    cwd: string,
    restoreTokens: readonly string[],
  ) {
    const root = path.resolve(cwd);
    const targets = yield* Effect.forEach(restoreTokens, (token) =>
      Effect.gen(function* () {
        const record = restoreRecords.get(token);
        // Tokens are server-issued and per project: a client never names a trash path.
        if (record === undefined || record.root !== root) {
          return yield* fail("not_found", token, "That item is no longer in the trash.");
        }
        const destination = yield* resolveEntry(cwd, record.relativePath);
        yield* requireAbsent(destination);
        return { token, record, destination };
      }),
    );
    const entries: ProjectChangedEntry[] = [];
    const failures: { relativePath: string; message: string }[] = [];
    for (const { token, record, destination } of targets) {
      const restored = yield* trash
        .putBack(record.entry, destination.absolutePath)
        .pipe(Effect.result);
      if (restored._tag === "Failure") {
        failures.push({
          relativePath: destination.relativePath,
          message: restored.failure.message,
        });
        continue;
      }
      restoreRecords.delete(token);
      entries.push({ relativePath: destination.relativePath });
    }
    return { entries, failures };
  });

  const changeEntry: WorkspaceEntryChanges["Service"]["changeEntry"] = Effect.fn(
    "WorkspaceEntryChanges.changeEntry",
  )(function* ({ cwd, change }) {
    yield* knownWorkspaces
      .assertContains(cwd)
      .pipe(
        Effect.mapError(() =>
          fail("outside_root", ".", "This folder is not a project on this environment."),
        ),
      );
    let result: ProjectChangeEntryResult;
    switch (change._tag) {
      case "create":
        result = {
          entries: yield* createEntry(cwd, change.relativePath, change.kind),
          failures: [],
        };
        break;
      case "import":
        result = {
          entries: yield* importEntry(cwd, change.relativePath, change.contentsBase64),
          failures: [],
        };
        break;
      case "move":
        result = {
          entries: yield* moveEntry(cwd, change.relativePath, change.newRelativePath),
          failures: [],
        };
        break;
      case "duplicate":
        result = { entries: yield* duplicateEntry(cwd, change.relativePath), failures: [] };
        break;
      case "delete":
        result = yield* deleteEntries(cwd, change.relativePaths, change.mode);
        break;
      case "restore":
        result = yield* restoreEntries(cwd, change.restoreTokens);
        break;
    }
    yield* workspaceEntries.refresh(cwd);
    return result;
  });

  return WorkspaceEntryChanges.of({ changeEntry });
});

export const layer = Layer.effect(WorkspaceEntryChanges, make);
