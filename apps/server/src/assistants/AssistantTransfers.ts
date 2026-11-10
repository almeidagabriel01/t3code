// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import {
  ASSISTANT_TRANSFER_HEADING,
  type AssistantLibrary,
  type AssistantLibraryFile,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const TRANSFER_MAX_FILE_BYTES = 100 * 1024 * 1024;
const TRANSFER_MAX_TOTAL_BYTES = 250 * 1024 * 1024;

export class AssistantTransferError extends Schema.TaggedError<AssistantTransferError>()(
  "AssistantTransferError",
  { message: Schema.String },
) {}

const isAssistantTransferError = Schema.is(AssistantTransferError);

interface ManifestFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");

/** Each transfer lives under its sender: deleting the sender removes everything it handed over. */
const ownerDir = (sharedDir: string, ownerId: string) =>
  NodePath.join(sharedDir, "transfers", safe(ownerId));
const transferDir = (sharedDir: string, ownerId: string, transferId: string) =>
  NodePath.join(ownerDir(sharedDir, ownerId), safe(transferId));

const sha256Of = async (file: string) => {
  const hash = NodeCrypto.createHash("sha256");
  await NodeStreamPromises.pipeline(NodeFS.createReadStream(file), hash);
  return hash.digest("hex");
};

const fail = (message: string) => new AssistantTransferError({ message });

/**
 * Copies `paths` into `<shared>/transfers/<owner>/<transferId>/` with a manifest written last, so a
 * folder with a manifest is complete and a repeat of the same transfer returns it without copying.
 * Every file is checked before the first is copied.
 */
export const copyTransfer = (input: {
  readonly sharedDir: string;
  readonly ownerId: string;
  readonly transferId: string;
  readonly sender: { readonly name: string; readonly handle: string };
  readonly recipients: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
}): Effect.Effect<ReadonlyArray<string>, AssistantTransferError> =>
  Effect.tryPromise({
    try: async () => {
      const dir = transferDir(input.sharedDir, input.ownerId, input.transferId);
      const manifestPath = NodePath.join(dir, "manifest.json");
      const existing = await NodeFSP.readFile(manifestPath, "utf8").catch(() => null);
      if (existing !== null) {
        // @effect-diagnostics-next-line globalJsonInEffect:off -- runs inside tryPromise, whose catch maps a parse failure.
        const manifest = JSON.parse(existing) as { readonly files: ReadonlyArray<ManifestFile> };
        return manifest.files.map((file) => file.path);
      }
      let total = 0;
      const sources: Array<{ readonly source: string; readonly size: number }> = [];
      for (const source of input.paths) {
        if (!NodePath.isAbsolute(source)) throw fail(`${source} is not an absolute path.`);
        const stat = await NodeFSP.stat(source).catch(() => null);
        if (stat === null) throw fail(`${source} does not exist.`);
        if (!stat.isFile()) throw fail(`${source} is not a file.`);
        await NodeFSP.access(source, NodeFSP.constants.R_OK).catch(() => {
          throw fail(`${source} cannot be read.`);
        });
        if (stat.size > TRANSFER_MAX_FILE_BYTES) {
          throw fail(
            `${source} is over the ${TRANSFER_MAX_FILE_BYTES / 1024 / 1024} MiB limit per file.`,
          );
        }
        total += stat.size;
        sources.push({ source, size: stat.size });
      }
      if (total > TRANSFER_MAX_TOTAL_BYTES) {
        throw fail(`The files add up to over ${TRANSFER_MAX_TOTAL_BYTES / 1024 / 1024} MiB.`);
      }
      await NodeFSP.mkdir(dir, { recursive: true });
      const taken = new Set<string>();
      const files: Array<ManifestFile> = [];
      for (const [index, { source, size }] of sources.entries()) {
        const base = safe(NodePath.basename(source));
        const name = taken.has(base) ? `${index + 1}-${base}` : base;
        taken.add(name);
        const target = NodePath.join(dir, name);
        const sha256 = await sha256Of(source);
        await NodeFSP.copyFile(source, target);
        if ((await sha256Of(target)) !== sha256) {
          throw fail(`${source} changed while it was copied. Send it again.`);
        }
        files.push({ name, path: target, size, sha256 });
      }
      const manifest = {
        transferId: input.transferId,
        sender: input.sender,
        recipients: input.recipients,
        files,
      };
      // @effect-diagnostics-next-line globalJsonInEffect:off -- runs inside tryPromise, whose catch maps failures.
      await NodeFSP.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      return files.map((file) => file.path);
    },
    catch: (cause) =>
      isAssistantTransferError(cause)
        ? cause
        : fail(
            `The files could not be copied: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
  });

const remove = (target: string) =>
  Effect.promise(() => NodeFSP.rm(target, { recursive: true, force: true })).pipe(Effect.ignore);

/** A transfer that was never delivered. */
export const removeTransfer = (sharedDir: string, ownerId: string, transferId: string) =>
  remove(transferDir(sharedDir, ownerId, transferId));

/** The assistant was deleted: everything it handed over goes, nothing else in `shared/`. */
export const removeOwnerTransfers = (sharedDir: string, ownerId: string) =>
  remove(ownerDir(sharedDir, ownerId));

const LIBRARY_MAX_FILES = 200;

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await NodeFSP.readFile(file, "utf8")) as unknown;

/**
 * Files the assistant handed over (its own folder) and received (other senders' manifests that
 * name one of its threads), newest first. One unreadable manifest hides only itself.
 */
export const listLibrary = (sharedDir: string, assistantId: string) =>
  Effect.promise(async (): Promise<AssistantLibrary> => {
    const root = NodePath.join(sharedDir, "transfers");
    const mine = safe(assistantId);
    const threadPrefix = `assistant:${assistantId}:`;
    const found: Array<AssistantLibraryFile> = [];
    for (const owner of await NodeFSP.readdir(root).catch(() => [])) {
      for (const transfer of await NodeFSP.readdir(NodePath.join(root, owner)).catch(() => [])) {
        const manifestPath = NodePath.join(root, owner, transfer, "manifest.json");
        const manifest = (await readJson(manifestPath).catch(() => null)) as {
          readonly sender?: { readonly name?: unknown };
          readonly recipients?: unknown;
          readonly files?: unknown;
        } | null;
        if (manifest === null || typeof manifest !== "object") continue;
        const sent = owner === mine;
        const received =
          !sent &&
          Array.isArray(manifest.recipients) &&
          manifest.recipients.some(
            (recipient) => typeof recipient === "string" && recipient.startsWith(threadPrefix),
          );
        if (!sent && !received) continue;
        const stat = await NodeFSP.stat(manifestPath).catch(() => null);
        if (stat === null || !Array.isArray(manifest.files)) continue;
        for (const file of manifest.files as ReadonlyArray<Partial<ManifestFile>>) {
          // A manifest names paths under its own folder; anything else is not ours to list.
          if (
            typeof file?.name !== "string" ||
            typeof file.path !== "string" ||
            !file.path.startsWith(`${root}${NodePath.sep}`)
          ) {
            continue;
          }
          found.push({
            name: file.name,
            path: file.path,
            size: typeof file.size === "number" ? file.size : 0,
            direction: sent ? "sent" : "received",
            from: sent || typeof manifest.sender?.name !== "string" ? null : manifest.sender.name,
            savedAt: stat.mtime.toISOString(),
          });
        }
      }
    }
    found.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.name.localeCompare(b.name));
    return {
      files: found.slice(0, LIBRARY_MAX_FILES),
      truncated: found.length > LIBRARY_MAX_FILES,
    };
  });

/** What the recipient reads: where the copies are, as links the clients open in the file viewer. */
export const transferText = (paths: ReadonlyArray<string>) =>
  paths.length === 0
    ? ""
    : `\n${ASSISTANT_TRANSFER_HEADING}\n${paths
        .map((path) => `- [${NodePath.basename(path)}](<${path}>)`)
        .join("\n")}`;
