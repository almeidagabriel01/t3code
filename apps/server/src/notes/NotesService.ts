// @effect-diagnostics-next-line nodeBuiltinImport:off -- revisions hash the exact UTF-8 file bytes.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- no-follow numeric open flags are absent from Effect FileSystem.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- pin directory/file identities across pathname operations.
import * as NodeFSP from "node:fs/promises";
import {
  NOTE_BODY_MAX_BYTES,
  NoteConflictError,
  NoteError,
  NoteFolder,
  NoteId,
  NotePath,
  type NoteAuthor,
  type NoteCardLink,
  type NoteDocument,
  type NoteIssue,
  type NoteSkipped,
  type NotesDeleteInput,
  type NotesDeleteResult,
  type NotesEvent,
  type NotesListInput,
  type NotesListResult,
  type NotesMoveInput,
  type NotesReadInput,
  type NotesUpdateInput,
  type NotesWriteInput,
  type NoteSummary,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { parseNote, serializeNote, type NoteContents } from "./frontmatter.ts";
import * as NoteImages from "./NoteImages.ts";
import { bodySummary } from "./noteSummary.ts";
import * as NotesGit from "./NotesGit.ts";

const decodePath = Schema.decodeEffect(NotePath);
const decodeFolder = Schema.decodeEffect(NoteFolder);
const isPath = Schema.is(NotePath);
const isFolder = Schema.is(NoteFolder);
const LIST_LIMIT = 500;
const SKIPPED_LIMIT = 50;
const isMarkdownName = (name: string) => /\.(?:md|markdown)$/iu.test(name);
/** The API spelling of an on-disk name: NFC, and one `.md` for `.MD` and `.markdown` too. */
const fileKey = (name: string) => name.normalize("NFC").replace(/\.(?:md|markdown)$/iu, ".md");
const folderKey = (name: string) => name.normalize("NFC");
/** Exact spellings first, so every lookup and listing picks the same file among aliases. */
const aliasOrder = (entries: ReadonlyArray<string>, key: (name: string) => string) => [
  ...entries.filter((entry) => key(entry) === entry).toSorted(),
  ...entries.filter((entry) => key(entry) !== entry).toSorted(),
];
const resolveEntry = (
  entries: ReadonlyArray<string>,
  wanted: string,
  key: (name: string) => string,
) => aliasOrder(entries, key).find((entry) => key(entry) === wanted);
const ISSUE_LABEL: Record<NoteIssue, string> = {
  invalid_frontmatter: "header cannot be parsed",
  invalid_utf8: "file is not valid UTF-8",
  too_large: "file is too large",
};
const MAX_FILE_BYTES = NOTE_BODY_MAX_BYTES + 256 * 1024;
const summary = ({ body: _body, ...note }: NoteDocument): NoteSummary => note;
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const newNoteId = () => NoteId.make(NodeCrypto.randomUUID());

const strictUtf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};
const tryParseNote = (text: string) => {
  try {
    return parseNote(text);
  } catch {
    return null;
  }
};

export class NotesService extends Context.Service<
  NotesService,
  {
    readonly list: (input: NotesListInput) => Effect.Effect<NotesListResult, NoteError>;
    readonly read: (input: NotesReadInput) => Effect.Effect<NoteDocument, NoteError>;
    readonly write: (
      input: NotesWriteInput,
      author: NoteAuthor,
    ) => Effect.Effect<NoteDocument, NoteError | NoteConflictError>;
    readonly update: (input: NotesUpdateInput) => Effect.Effect<NoteDocument, NoteError>;
    readonly move: (
      input: NotesMoveInput,
      author: NoteAuthor,
    ) => Effect.Effect<NoteDocument, NoteError | NoteConflictError>;
    readonly delete: (
      input: NotesDeleteInput,
    ) => Effect.Effect<NotesDeleteResult, NoteError | NoteConflictError>;
    readonly subscribe: Stream.Stream<NotesEvent, NoteError>;
    /** The note with an id, writing one into a file that has none yet. */
    readonly identify: (
      path: NotePath,
    ) => Effect.Effect<NoteDocument & { readonly id: NoteId }, NoteError>;
    readonly linkCard: (
      path: NotePath,
      card: NoteCardLink,
      author: NoteAuthor,
    ) => Effect.Effect<NoteDocument, NoteError>;
    /** Clears the card link of every note that points at the card; for when the card is gone. */
    readonly unlinkCard: (cardId: NoteCardLink["cardId"]) => Effect.Effect<void, NoteError>;
    /** Notes that link a card, so a caller can check each link still resolves. */
    readonly linkedCards: Effect.Effect<ReadonlyArray<{ path: NotePath; card: NoteCardLink }>>;
  }
>()("t3/notes/NotesService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* NotesGit.NotesGit;
  const images = yield* NoteImages.NoteImages;
  const projections = yield* Projections.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
  const lock = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<NotesEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  const storage = new NoteError({ reason: "storage", message: "Note storage is unavailable." });
  yield* fs
    .makeDirectory(config.notesDir, { recursive: true })
    .pipe(Effect.mapError(() => storage));
  const root = yield* fs.realPath(config.notesDir).pipe(Effect.mapError(() => storage));
  const known = new Map<NotePath, string>();
  const readModel = new Map<NotePath, NoteDocument>();
  // Every note path on disk. The first LIST_LIMIT by path are the listed ones, in the snapshot and
  // in live events alike.
  const index = new Set<NotePath>();
  const listedNow = () => new Set([...index].sort().slice(0, LIST_LIMIT));
  const omittedNow = () => Math.max(0, index.size - LIST_LIMIT);

  // Path pinning, loading and persisting run inside the public operations' spans.
  const invalidPath = (name: string) =>
    new NoteError({
      reason: "invalid_path",
      message: "Use the exact spelling of a regular note path without symlinks.",
      path: name,
    });
  const io = <A>(name: string, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) => {
        const code = (cause as NodeJS.ErrnoException).code;
        return code === "ENOENT"
          ? new NoteError({ reason: "not_found", message: "The note was not found.", path: name })
          : code === "ELOOP" || code === "ENOTDIR"
            ? invalidPath(name)
            : storage;
      },
    });
  const open = (name: string, absolute: string, flags: number) =>
    Effect.acquireRelease(
      io(name, () => NodeFSP.open(absolute, flags)),
      (handle) => Effect.promise(() => handle.close()),
    );
  const pinDirectory = Effect.fnUntraced(function* (input: string, create = false) {
    const name = yield* decodePath(input).pipe(Effect.mapError(() => invalidPath(input)));
    const directoryFlags =
      NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_DIRECTORY ?? 0) |
      (NodeFS.constants.O_NOFOLLOW ?? 0);
    const pins: Array<{ absolute: string; handle: NodeFSP.FileHandle }> = [];
    const rootHandle = yield* open(name, root, directoryFlags);
    pins.push({ absolute: root, handle: rootHandle });
    const verify = Effect.gen(function* () {
      for (const pin of pins) {
        const current = yield* io(name, () => NodeFSP.lstat(pin.absolute));
        const pinned = yield* io(name, () => pin.handle.stat());
        const real = yield* io(name, () => NodeFSP.realpath(pin.absolute));
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.ino !== pinned.ino ||
          current.dev !== pinned.dev ||
          real !== pin.absolute
        )
          return yield* invalidPath(name);
      }
    });
    const segments = name.split("/");
    let parent = root;
    if (segments.length === 2) {
      yield* verify;
      const folder = segments[0]!;
      const entries = yield* io(name, () => NodeFSP.readdir(root));
      // The directory's own spelling may be NFD; only a listed entry is ever opened.
      const actualFolder = resolveEntry(entries, folder, folderKey);
      parent = path.join(root, actualFolder ?? folder);
      const info = yield* io(name, () => NodeFSP.lstat(parent)).pipe(
        Effect.catchTags({
          NoteError: (error) =>
            error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      // Found without being listed: a case-insensitive alias of another spelling.
      if (info && (actualFolder === undefined || info.isSymbolicLink()))
        return yield* invalidPath(name);
      if (!info && create) yield* fs.makeDirectory(parent).pipe(Effect.mapError(() => storage));
      const handle = yield* open(name, parent, directoryFlags);
      pins.push({ absolute: parent, handle });
    }
    yield* verify;
    const listing = yield* io(name, () => NodeFSP.readdir(parent)).pipe(
      Effect.catchTags({
        NoteError: (error) =>
          error.reason === "not_found" ? Effect.succeed([]) : Effect.fail(error),
      }),
    );
    const actualFile = resolveEntry(listing, segments.at(-1)!, fileKey) ?? segments.at(-1)!;
    const absolute = path.join(parent, actualFile);
    const verifyFile = Effect.gen(function* () {
      yield* verify;
      const info = yield* io(name, () => NodeFSP.lstat(absolute)).pipe(
        Effect.catchTags({
          NoteError: (error) =>
            error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (info) {
        const entries = yield* io(name, () => NodeFSP.readdir(parent));
        if (!info.isFile() || info.isSymbolicLink() || !entries.includes(actualFile))
          return yield* invalidPath(name);
      }
      return info;
    });
    yield* verifyFile;
    const pinTemporary = Effect.fnUntraced(function* (absolute: string) {
      const handle = yield* open(name, absolute, directoryFlags);
      pins.push({ absolute, handle });
      yield* verify;
    });
    return { name, absolute, parent, verify, verifyFile, pinTemporary };
  });

  /** Loads a note, or a degraded stand-in for a file T3 Code cannot understand (contents is null). */
  const loadAny = Effect.fnUntraced(function* (input: string) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* pinDirectory(input);
        const { name, absolute } = directory;
        const handle = yield* open(
          name,
          absolute,
          NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
        );
        yield* directory.verify;
        const info = yield* io(name, () => handle.stat());
        if (!info.isFile()) return yield* invalidPath(name);
        const folder = name.includes("/") ? name.split("/")[0]! : null;
        const degraded = (issue: NoteIssue, revision: string, body: string) => {
          const document: NoteDocument = {
            id: null,
            path: name,
            folder,
            title: bodySummary("", path.basename(name, ".md")).title,
            preview: `Not editable: its ${ISSUE_LABEL[issue]}.`,
            pinned: false,
            related: [],
            card: null,
            updatedBy: null,
            issue,
            revision,
            updatedAt: info.mtime.toISOString(),
            size: info.size,
            body,
          };
          readModel.set(name, document);
          return { document, contents: null, absolute };
        };
        // Unread, so the revision stands for size and mtime; it only has to change with the file.
        if (info.size > MAX_FILE_BYTES)
          return degraded(
            "too_large",
            sha256(new TextEncoder().encode(`too_large:${info.size}:${info.mtimeMs}`)),
            "",
          );
        const bytes = yield* io(name, () => handle.readFile());
        yield* directory.verify;
        const revision = sha256(bytes);
        const decoded = strictUtf8(bytes);
        if (decoded === null)
          return degraded("invalid_utf8", revision, new TextDecoder().decode(bytes));
        const contents = tryParseNote(decoded);
        if (contents === null) return degraded("invalid_frontmatter", revision, decoded);
        const projectMissing =
          contents.project !== null &&
          (yield* projects.get(contents.project).pipe(
            Effect.map(Option.isNone),
            Effect.orElseSucceed(() => false),
          ));
        const document: NoteDocument = {
          id: contents.id,
          path: name,
          folder,
          ...bodySummary(contents.body, path.basename(name, ".md")),
          pinned: contents.pinned,
          related: contents.related,
          card: contents.card,
          ...(contents.project === null ? {} : { project: contents.project }),
          ...(projectMissing ? { projectMissing: true as const } : {}),
          updatedBy: contents.updatedBy,
          revision,
          updatedAt: info.mtime.toISOString(),
          size: bytes.byteLength,
          body: contents.body,
        };
        readModel.set(name, document);
        return { document, contents, absolute };
      }),
    );
  });
  /** For writers: a note T3 Code cannot understand is refused, never rewritten from a guess. */
  const load = Effect.fnUntraced(function* (input: string) {
    const loaded = yield* loadAny(input);
    if (loaded.contents === null)
      return yield* new NoteError({
        reason: "invalid",
        message: `This note was left unchanged because its ${ISSUE_LABEL[loaded.document.issue!]}. Fix the file or delete it.`,
        path: loaded.document.path,
      });
    return { ...loaded, contents: loaded.contents };
  });
  const optionalLoad = (name: string) =>
    load(name).pipe(
      Effect.catchTags({
        NoteError: (error) =>
          error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
  const optionalLoadAny = (name: string) =>
    loadAny(name).pipe(
      Effect.catchTags({
        NoteError: (error) =>
          error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
  /** Applies an index change and tells clients which notes entered or left the listed cut. */
  const settle = Effect.fnUntraced(function* (change: NotePath, apply: () => void) {
    const before = listedNow();
    apply();
    const after = listedNow();
    const omitted = omittedNow();
    for (const name of before)
      if (!after.has(name) && name !== change)
        yield* PubSub.publish(events, { type: "removed", path: name, omitted });
    for (const name of after) {
      if (before.has(name) || name === change) continue;
      const document = readModel.get(name) ?? (yield* optionalLoadAny(name))?.document;
      if (document)
        yield* PubSub.publish(events, { type: "upserted", note: summary(document), omitted });
    }
    return { listed: after.has(change), omitted };
  });
  const publish = Effect.fnUntraced(function* (note: NoteDocument) {
    readModel.set(note.path, note);
    known.set(note.path, note.revision);
    const { listed, omitted } = yield* settle(note.path, () => index.add(note.path));
    yield* PubSub.publish(
      events,
      listed
        ? { type: "upserted", note: summary(note), omitted }
        : { type: "removed", path: note.path, omitted },
    );
    yield* git.changed;
  });
  const removed = Effect.fnUntraced(function* (name: NotePath) {
    known.delete(name);
    readModel.delete(name);
    const { omitted } = yield* settle(name, () => index.delete(name));
    yield* PubSub.publish(events, { type: "removed", path: name, omitted });
    yield* git.changed;
  });
  const persist = Effect.fnUntraced(function* (
    name: NotePath,
    contents: NoteContents,
    /** The revision the caller read, or null to create a note that must not exist yet. */
    expected: string | null,
    emit = true,
  ) {
    const bytes = new TextEncoder().encode(serializeNote(contents));
    if (bytes.byteLength > MAX_FILE_BYTES)
      return yield* new NoteError({
        reason: "too_large",
        message: "The note is too large.",
        path: name,
      });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* pinDirectory(name, true);
        yield* directory.verifyFile;
        const temporary = yield* fs
          .makeTempDirectoryScoped({ directory: directory.parent, prefix: ".note-" })
          .pipe(Effect.mapError(() => storage));
        yield* directory.verifyFile;
        yield* directory.pinTemporary(temporary);
        const temp = path.join(temporary, "contents.tmp");
        const handle = yield* open(
          name,
          temp,
          NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_EXCL |
            (NodeFS.constants.O_NOFOLLOW ?? 0),
        );
        yield* directory.verify;
        yield* io(name, () => handle.writeFile(bytes));
        yield* directory.verifyFile;
        // Pathname syscalls retain a directory-swap window after these checks, including cleanup.
        // A process able to rename folders here already has the user's write access, so such swaps
        // are outside the notes containment threat model.
        if (expected === null) yield* createExclusive(name, temp, directory.absolute);
        else {
          yield* expectOnDisk(name, directory.absolute, expected);
          // POSIX has no compare-and-rename, so an edit landing between this check and rename(2)
          // is still replaced. The window is a few syscalls instead of the whole write.
          yield* fs.rename(temp, directory.absolute).pipe(Effect.mapError(() => storage));
        }
        yield* directory.verify;
      }),
    );
    const { document } = yield* load(name);
    if (emit) yield* publish(document);
    return document;
  });
  const unlink = (name: NotePath, expected: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* pinDirectory(name);
        yield* directory.verifyFile;
        yield* expectOnDisk(name, directory.absolute, expected);
        // POSIX has no compare-and-unlink. rename(2) takes whatever is at the path at that instant,
        // so an edit after the check above is caught and linked back; only a writer that keeps the
        // file open past the second check still loses its edit. Captured bytes leave the disk only
        // once they prove to be the expected revision or are linked back.
        let captured = false;
        const aside = yield* Effect.acquireRelease(
          fs
            .makeTempDirectory({ directory: directory.parent, prefix: ".note-" })
            .pipe(Effect.mapError(() => storage)),
          (temporary) =>
            captured
              ? Effect.void
              : fs.remove(temporary, { recursive: true }).pipe(Effect.ignore({ log: true })),
        );
        yield* directory.pinTemporary(aside);
        const removed = path.join(aside, "removed.md");
        const unmoved = new NoteError({
          reason: "storage",
          message: "The note was kept because it could not be moved aside for removal.",
          path: name,
        });
        // Stopping between the rename and its outcome would leave the note's path empty.
        const changed = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            // No copy-and-unlink fallback (EXDEV, EBUSY on a bind mount): the note stays put.
            yield* io(name, () => NodeFSP.rename(directory.absolute, removed)).pipe(
              Effect.mapError((error) => (error.reason === "storage" ? unmoved : error)),
            );
            captured = true;
            const revision = yield* diskRevision(name, removed).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            // Verify containment before discarding anything: a failure after the bytes are gone
            // would make a move roll back its destination too.
            const verified = yield* directory.verify.pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (revision === expected && verified) return (captured = false);
            // link(2) never replaces a file created at the path meanwhile, and unlike a copy the
            // restored note is complete the moment it is visible.
            captured = yield* Effect.tryPromise(() =>
              NodeFSP.link(removed, directory.absolute),
            ).pipe(
              Effect.as(false),
              Effect.orElseSucceed(() => true),
            );
            return true;
          }),
        );
        if (captured)
          return yield* new NoteError({
            reason: "storage",
            message: `The note changed while it was being removed and could not be put back. Its contents are in ${path.relative(root, removed)}.`,
            path: name,
          });
        if (changed) return yield* changedOnDisk(name, expected);
        readModel.delete(name);
      }),
    );
  const checkRevision = (document: NoteDocument, revision: string) =>
    document.revision === revision
      ? Effect.void
      : Effect.fail(
          new NoteConflictError({
            path: document.path,
            current: document,
            message: "The note changed. Read it again before retrying.",
          }),
        );
  const conflictMessage = "The note changed. Read it again before retrying.";
  /** The revision of the bytes at absolute now, or null when no file is there. */
  const diskRevision = (name: NotePath, absolute: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* open(
          name,
          absolute,
          NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
        );
        const info = yield* io(name, () => handle.stat());
        // Larger than any revision a caller can hold, so it can only differ.
        if (info.size > MAX_FILE_BYTES) return "";
        return sha256(yield* io(name, () => handle.readFile()));
      }),
    ).pipe(
      Effect.catchTags({
        NoteError: (error) =>
          error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
  /** Fails unless the file still holds the revision the caller decided on. */
  const expectOnDisk = Effect.fnUntraced(function* (
    name: NotePath,
    absolute: string,
    expected: string | null,
  ) {
    if ((yield* diskRevision(name, absolute)) === expected) return;
    return yield* changedOnDisk(name, expected);
  });
  /** The error for a note whose file no longer holds the expected revision. */
  const changedOnDisk = Effect.fnUntraced(function* (name: NotePath, expected: string | null) {
    const current = yield* optionalLoadAny(name);
    if (!current)
      return yield* new NoteError({
        reason: "not_found",
        message: "The note was not found.",
        path: name,
      });
    if (expected === null)
      return yield* new NoteError({
        reason: "exists",
        message: "The note already exists.",
        path: name,
      });
    return yield* new NoteConflictError({
      path: name,
      current: current.document,
      message: conflictMessage,
    });
  });
  /** link(2) refuses an existing destination, so a file created meanwhile is never replaced. */
  const createExclusive = (name: NotePath, temp: string, absolute: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.link(temp, absolute),
      catch: (cause) => (cause as NodeJS.ErrnoException).code,
    }).pipe(
      Effect.catch((code) =>
        code === "EEXIST"
          ? Effect.fail(
              new NoteError({
                reason: "exists",
                message: "The note already exists.",
                path: name,
              }),
            )
          : code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP"
            ? // Volumes without hard links copy with O_EXCL instead: still never replacing a file,
              // though a reader can briefly see a partial copy.
              Effect.tryPromise({
                try: () => NodeFSP.copyFile(temp, absolute, NodeFS.constants.COPYFILE_EXCL),
                catch: (cause) =>
                  (cause as NodeJS.ErrnoException).code === "EEXIST"
                    ? new NoteError({
                        reason: "exists",
                        message: "The note already exists.",
                        path: name,
                      })
                    : storage,
              })
            : Effect.fail(storage),
      ),
    );
  /** Header updates and card links own no user revision, so a racing edit makes them read again. */
  const rereadOnConflict = <A>(effect: Effect.Effect<A, NoteError | NoteConflictError>) =>
    effect.pipe(
      Effect.retry({ times: 3, while: (error) => error._tag === "NoteConflictError" }),
      Effect.catchTags({
        NoteConflictError: () =>
          Effect.fail(
            new NoteError({
              reason: "storage",
              message: "The note kept changing during the update. Try again.",
            }),
          ),
      }),
    );

  const scan = Effect.fnUntraced(function* (input: NotesListInput, limit = LIST_LIMIT) {
    if (input.folder !== undefined)
      yield* decodeFolder(input.folder).pipe(
        Effect.mapError(
          () => new NoteError({ reason: "invalid_path", message: "Invalid note folder." }),
        ),
      );
    const entries = yield* fs.readDirectory(root).pipe(Effect.mapError(() => storage));
    const folders: Array<string> = [];
    const all: Array<NotePath> = [];
    const skipped: Array<NoteSkipped> = [];
    // Names that failed to read for a reason that may pass, so a refresh keeps their last state.
    const unreadable = new Set<string>();
    const skip = (name: string, reason: NoteSkipped["reason"]) => {
      if (skipped.length < SKIPPED_LIMIT) skipped.push({ name, reason });
    };
    const addFrom = (prefix: string, listing: ReadonlyArray<string>) => {
      const seen = new Set<string>();
      for (const entry of aliasOrder(listing, fileKey)) {
        if (entry.startsWith(".")) continue;
        const name = `${prefix}${fileKey(entry)}`;
        if (!isPath(name)) {
          if (isMarkdownName(entry)) skip(`${prefix}${entry}`, "unsupported_name");
        } else if (seen.has(name)) skip(`${prefix}${entry}`, "duplicate_name");
        else {
          seen.add(name);
          all.push(name);
        }
      }
    };
    const rootFiles: Array<string> = [];
    const seenFolders = new Set<string>();
    for (const entry of aliasOrder(entries, folderKey)) {
      if (entry.startsWith(".")) continue;
      const entryPath = path.join(root, entry);
      const info = yield* fs.stat(entryPath).pipe(Effect.option);
      if (Option.isNone(info)) {
        if (isMarkdownName(entry)) skip(entry, "unreadable");
        continue;
      }
      if (info.value.type === "Directory") {
        const folder = folderKey(entry);
        if (!isFolder(folder)) {
          skip(entry, "unsupported_name");
          continue;
        }
        if (seenFolders.has(folder)) {
          skip(entry, "duplicate_name");
          continue;
        }
        const real = yield* fs.realPath(entryPath).pipe(Effect.option);
        if (
          Option.isNone(real) ||
          path.relative(root, real.value).startsWith("..") ||
          path.isAbsolute(path.relative(root, real.value))
        ) {
          skip(entry, "unreadable");
          continue;
        }
        seenFolders.add(folder);
        folders.push(folder);
        if (input.folder !== undefined && folder !== input.folder) continue;
        const children = yield* fs.readDirectory(entryPath).pipe(Effect.mapError(() => storage));
        for (const child of children.toSorted()) {
          if (child.startsWith(".") || isMarkdownName(child)) continue;
          const nested = yield* fs.stat(path.join(entryPath, child)).pipe(Effect.option);
          if (Option.isSome(nested) && nested.value.type === "Directory")
            skip(`${folder}/${child}`, "nested_too_deep");
        }
        addFrom(`${folder}/`, children);
      } else if (input.folder === undefined) rootFiles.push(entry);
    }
    addFrom("", rootFiles);
    all.sort();
    const names = all.slice(0, limit);
    const omitted = all.length - names.length;
    const loaded = yield* Effect.forEach(
      names,
      (name) =>
        loadAny(name).pipe(
          Effect.map(({ document }) => document),
          Effect.catchTags({
            NoteError: (error) => {
              // Gone since the directory was read: nothing to list. Anything else is reported.
              if (error.reason === "not_found") return Effect.succeed(null);
              skip(name, "unreadable");
              if (error.reason === "storage") unreadable.add(name);
              return Effect.succeed(null);
            },
          }),
        ),
      { concurrency: 4 },
    );
    return {
      notes: loaded
        .filter((note): note is NoteDocument => note !== null)
        .filter((note) => input.project === undefined || note.project === input.project),
      folders,
      truncated: omitted > 0,
      ...(omitted > 0 ? { omitted } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
      unreadable,
      all,
    };
  });
  const read = Effect.fn("NotesService.read")(function* (input: NotesReadInput) {
    return (yield* lock.withPermits(1)(loadAny(input.path))).document;
  });
  const list = Effect.fn("NotesService.list")(function* (input: NotesListInput) {
    const {
      unreadable: _unreadable,
      all: _all,
      ...result
    } = yield* lock.withPermits(1)(scan(input));
    return { ...result, notes: result.notes.map(summary) };
  });
  const write = Effect.fn("NotesService.write")(function* (
    input: NotesWriteInput,
    author: NoteAuthor,
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (new TextEncoder().encode(input.body).byteLength > NOTE_BODY_MAX_BYTES)
          return yield* new NoteError({
            reason: "too_large",
            message: "The note body exceeds 1 MiB.",
            path: input.path,
          });
        const existing = yield* optionalLoad(input.path);
        if (existing && input.baseRevision === null)
          return yield* new NoteError({
            reason: "exists",
            message: "The note already exists.",
            path: input.path,
          });
        if (!existing && input.baseRevision !== null)
          return yield* new NoteError({
            reason: "not_found",
            message: "The note was not found.",
            path: input.path,
          });
        if (existing && input.baseRevision !== null)
          yield* checkRevision(existing.document, input.baseRevision);
        const id = existing?.contents.id ?? newNoteId();
        return yield* persist(
          input.path,
          {
            metadata: existing?.contents.metadata ?? null,
            id,
            body: yield* images.claim(id, input.body),
            pinned: existing?.contents.pinned ?? false,
            related: existing?.contents.related ?? [],
            card: existing?.contents.card ?? null,
            project: input.project ?? existing?.contents.project ?? null,
            updatedBy: author,
          },
          existing?.document.revision ?? null,
        );
      }),
    );
  });
  const update = Effect.fn("NotesService.update")(function* (input: NotesUpdateInput) {
    return yield* lock.withPermits(1)(
      rereadOnConflict(
        Effect.gen(function* () {
          const source = yield* load(input.path);
          const pinned = input.pinned ?? source.contents.pinned;
          let related = source.contents.related;
          const ref = input.relate;
          if (ref && !related.includes(ref)) {
            const thread = yield* projections.getThread(ref).pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
              }),
              Effect.mapError(() => storage),
            );
            if (!thread || thread.deletedAt !== null)
              return yield* new NoteError({
                reason: "not_found",
                message: "The thread was not found in this environment.",
                path: input.path,
              });
            related = [...related, ref];
          }
          if (input.unrelate) related = related.filter((entry) => entry !== input.unrelate);
          const card = input.card === null ? null : source.contents.card;
          const project = input.project === undefined ? source.contents.project : input.project;
          if (
            card === source.contents.card &&
            project === source.contents.project &&
            pinned === source.contents.pinned &&
            related.length === source.contents.related.length &&
            related.every((entry, index) => entry === source.contents.related[index])
          )
            return source.document;
          return yield* persist(
            input.path,
            {
              ...source.contents,
              id: source.contents.id ?? newNoteId(),
              pinned,
              related,
              card,
              project,
            },
            source.document.revision,
          );
        }),
      ),
    );
  });
  const move = Effect.fn("NotesService.move")(function* (
    input: NotesMoveInput,
    author: NoteAuthor,
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const source = yield* load(input.from);
        yield* checkRevision(source.document, input.baseRevision);
        if (input.from === input.to) return source.document;
        if (yield* optionalLoadAny(input.to))
          return yield* new NoteError({
            reason: "exists",
            message: "The destination already exists.",
            path: input.to,
          });
        const contents: NoteContents = {
          ...source.contents,
          id: source.contents.id ?? newNoteId(),
          updatedBy: author,
        };
        const document = yield* persist(input.to, contents, null, false);
        // Roll back only the bytes this move placed; a destination edited since then stays. A
        // storage failure there can hold a captured edit, so it is reported with the first error.
        const placed = sha256(new TextEncoder().encode(serializeNote(contents)));
        yield* unlink(source.document.path, source.document.revision).pipe(
          Effect.tapError((error) =>
            unlink(input.to, placed).pipe(
              Effect.catch((rollback) =>
                rollback._tag === "NoteError" && rollback.reason === "storage"
                  ? Effect.fail(
                      new NoteError({
                        reason: "storage",
                        message: `${error.message} The moved copy could not be removed: ${rollback.message}`,
                        path: input.to,
                      }),
                    )
                  : Effect.void,
              ),
            ),
          ),
        );
        yield* publish(document);
        yield* removed(input.from);
        return document;
      }),
    );
  });
  const remove = Effect.fn("NotesService.delete")(function* (input: NotesDeleteInput) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // A note T3 Code cannot parse can still be deleted, except an unread oversized file.
        const source = yield* loadAny(input.path);
        if (source.document.issue === "too_large")
          return yield* new NoteError({
            reason: "too_large",
            message: "The note is too large to delete here. Remove the file directly.",
            path: input.path,
          });
        yield* checkRevision(source.document, input.baseRevision);
        yield* unlink(source.document.path, source.document.revision);
        yield* removed(input.path);
        if (source.contents?.id) yield* images.release(source.contents.id, source.contents.body);
        return { path: input.path };
      }),
    );
  });
  const identify = Effect.fn("NotesService.identify")(function* (name: NotePath) {
    return yield* lock.withPermits(1)(
      rereadOnConflict(
        Effect.gen(function* () {
          const source = yield* load(name);
          const document =
            source.document.id === null
              ? yield* persist(
                  name,
                  { ...source.contents, id: newNoteId() },
                  source.document.revision,
                )
              : source.document;
          return { ...document, id: document.id! };
        }),
      ),
    );
  });
  const linkCard = Effect.fn("NotesService.linkCard")(function* (
    name: NotePath,
    card: NoteCardLink,
    author: NoteAuthor,
  ) {
    return yield* lock.withPermits(1)(
      rereadOnConflict(
        Effect.gen(function* () {
          const source = yield* load(name);
          if (
            source.contents.card?.cardId === card.cardId &&
            source.contents.card.projectId === card.projectId
          )
            return source.document;
          return yield* persist(
            name,
            {
              ...source.contents,
              id: source.contents.id ?? newNoteId(),
              card,
              updatedBy: author,
            },
            source.document.revision,
          );
        }),
      ),
    );
  });
  const linkedCards = Effect.sync(() =>
    [...readModel.values()].flatMap((note) =>
      note.card ? [{ path: note.path, card: note.card }] : [],
    ),
  );
  const unlinkCard = Effect.fn("NotesService.unlinkCard")(function* (
    cardId: NoteCardLink["cardId"],
  ) {
    for (const note of yield* linkedCards)
      if (note.card.cardId === cardId) yield* update({ path: note.path, card: null });
  });
  const refresh = lock.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* scan({}, Infinity);
      const present = new Set<string>(snapshot.notes.map((note) => note.path));
      for (const note of snapshot.notes)
        if (known.get(note.path) !== note.revision) yield* publish(note);
      for (const name of new Set([...known.keys(), ...readModel.keys(), ...index]))
        if (!present.has(name) && !snapshot.unreadable.has(name)) yield* removed(name);
    }),
  );
  const subscribe = Stream.unwrap(
    // Subscribe before the snapshot while holding the same lock as every writer.
    lock.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(events);
        const snapshot = yield* scan({});
        return Stream.concat(
          Stream.succeed<NotesEvent>({
            type: "snapshot",
            ...snapshot,
            notes: snapshot.notes.map(summary),
          }),
          Stream.fromSubscription(subscription),
        );
      }),
    ),
  );
  const initial = yield* scan({}, Infinity);
  for (const note of initial.notes) known.set(note.path, note.revision);
  for (const name of initial.all) index.add(name);
  const ready = yield* Deferred.make<void>();
  const dirty = new Set<string>();
  /** Same policy as refresh: gone or unusable means removed; a failure that may pass keeps state. */
  const refreshDirty = lock.withPermits(1)(
    Effect.gen(function* () {
      const paths = [...dirty];
      dirty.clear();
      let failed = false;
      for (const name of paths) {
        if (!isPath(name)) continue;
        const outcome = yield* loadAny(name).pipe(
          Effect.map((source) => ({ source }) as const),
          Effect.catchTags({
            NoteError: (error) =>
              Effect.succeed(
                error.reason === "storage"
                  ? ({ retry: true } as const)
                  : ({ source: null } as const),
              ),
          }),
        );
        if ("retry" in outcome) {
          dirty.add(name);
          failed = true;
        } else if (outcome.source) {
          if (known.get(name) !== outcome.source.document.revision)
            yield* publish(outcome.source.document);
        } else if (known.has(name) || readModel.has(name) || index.has(name)) yield* removed(name);
      }
      if (failed) return yield* storage;
    }),
  );
  // Each (re)attached watcher first emits a marker for the root, which resyncs every note, so
  // edits made while it was detached are not lost.
  const watch = Stream.unwrap(
    Effect.gen(function* () {
      const attached = yield* Deferred.make<void>();
      return Stream.merge(
        Stream.fromEffect(Deferred.await(attached).pipe(Effect.as(root))),
        fs
          .watch(root, {
            recursive: true,
            onReady: () => {
              Deferred.doneUnsafe(attached, Effect.void);
              Deferred.doneUnsafe(ready, Effect.void);
            },
          })
          .pipe(Stream.map((event) => event.path)),
        { haltStrategy: "right" },
      );
    }),
  ).pipe(
    Stream.map((name) =>
      path
        .relative(root, path.isAbsolute(name) ? name : path.join(root, name))
        .split(path.sep)
        .map((segment, position, segments) =>
          position === segments.length - 1 ? fileKey(segment) : folderKey(segment),
        )
        .join("/"),
    ),
    Stream.filter((name) => !name.split("/").some((segment) => segment.startsWith("."))),
    Stream.tap((name) =>
      Effect.sync(() => {
        dirty.add(name);
      }),
    ),
    Stream.debounce("100 millis"),
    Stream.runForEach(() => {
      // A failed pass keeps its paths (refreshDirty) or marks the root dirty again (refresh), and
      // is retried, so a transient read error never leaves a note stale until the watcher reattaches.
      const pass = [...dirty].some((name) => !isPath(name))
        ? Effect.suspend(() => {
            dirty.clear();
            return refresh.pipe(Effect.tapError(() => Effect.sync(() => dirty.add(""))));
          })
        : refreshDirty;
      return pass.pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 5 }),
        Effect.ignore({ log: true }),
      );
    }),
    Effect.ensuring(Deferred.succeed(ready, undefined)),
    Effect.catch((error) => Effect.logWarning("Notes watcher stopped.", error)),
  );
  // projectMissing is computed on load, so a project removed or re-created is pushed live.
  const reconcileProject = (projectId: ProjectId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const missing = yield* projects.get(projectId).pipe(
          Effect.map(Option.isNone),
          Effect.orElseSucceed(() => false),
        );
        const listed = listedNow();
        for (const document of readModel.values()) {
          if (document.project !== projectId || (document.projectMissing === true) === missing)
            continue;
          const { projectMissing: _, ...rest } = document;
          const next: NoteDocument = missing ? { ...rest, projectMissing: true } : rest;
          readModel.set(document.path, next);
          if (listed.has(document.path))
            yield* PubSub.publish(events, {
              type: "upserted",
              note: summary(next),
              omitted: omittedNow(),
            });
        }
      }),
    );
  yield* applicationEvents.latestApplicationSequence.pipe(
    Effect.orElseSucceed(() => 0),
    Effect.flatMap((afterSequence) =>
      applicationEvents
        .streamApplicationEvents({ afterSequence })
        .pipe(
          Stream.runForEach((event) =>
            "aggregateKind" in event &&
            event.aggregateKind === "project" &&
            (event.type === "project.created" || event.type === "project.deleted")
              ? reconcileProject(event.aggregateId)
              : Effect.void,
          ),
        ),
    ),
    Effect.catch((error) => Effect.logWarning("Note project tracking stopped.", error)),
    Effect.forkScoped,
  );
  yield* watch.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
  yield* Deferred.await(ready);
  yield* git.changed;
  return NotesService.of({
    list,
    read,
    write,
    update,
    move,
    delete: remove,
    subscribe,
    identify,
    linkCard,
    unlinkCard,
    linkedCards,
  });
});

export const layer = Layer.effect(NotesService, make);
