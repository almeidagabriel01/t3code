// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { OrchestratorMcpThreadSendInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  copyTransfer,
  removeOwnerTransfers,
  removeTransfer,
  TRANSFER_MAX_FILE_BYTES,
  transferText,
} from "./AssistantTransfers.ts";

const sender = { name: "Asker", handle: "asker" };

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transfers-" });
  const sharedDir = path.join(root, "shared");
  const write = (name: string, text: string) =>
    Effect.gen(function* () {
      const file = path.join(root, name);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, text);
      return file;
    });
  const sparse = (name: string, bytes: number) =>
    Effect.gen(function* () {
      const file = path.join(root, name);
      yield* fs.writeFileString(file, "");
      yield* fs.truncate(file, bytes);
      return file;
    });
  return { fs, path, root, sharedDir, write, sparse };
});

const copy = (
  sharedDir: string,
  paths: ReadonlyArray<string>,
  transferId = "message:1",
  ownerId = "asker",
) =>
  copyTransfer({
    sharedDir,
    ownerId,
    transferId,
    sender,
    recipients: ["assistant:helper:1"],
    paths,
  });

it.effect("copies files with a manifest of name, size and sha256, and repeats copy nothing", () =>
  Effect.gen(function* () {
    const { fs, path, sharedDir, write } = yield* workspace;
    const a = yield* write("one/report.txt", "hello");
    const b = yield* write("two/report.txt", "world!");
    const copied = yield* copy(sharedDir, [a, b]);
    assert.deepEqual(
      copied.map((file) => path.relative(sharedDir, file)),
      ["transfers/asker/message_1/report.txt", "transfers/asker/message_1/2-report.txt"],
    );
    assert.equal(yield* fs.readFileString(copied[1]!), "world!");
    const manifest = JSON.parse(
      yield* fs.readFileString(path.join(sharedDir, "transfers/asker/message_1/manifest.json")),
    );
    assert.deepEqual(
      manifest.files[0].sha256,
      NodeCrypto.createHash("sha256").update("hello").digest("hex"),
    );
    assert.deepEqual(
      manifest.files.map((file: { size: number }) => file.size),
      [5, 6],
    );
    assert.deepEqual(manifest.recipients, ["assistant:helper:1"]);

    // A repeat of the same transfer returns the folder it made, even when the source changed.
    yield* fs.writeFileString(a, "changed");
    assert.deepEqual(yield* copy(sharedDir, [a, b]), copied);
    assert.equal(yield* fs.readFileString(copied[0]!), "hello");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "refuses a missing file, a folder, a relative path and oversize files, copying none",
  () =>
    Effect.gen(function* () {
      const { fs, root, sharedDir, write, sparse } = yield* workspace;
      const ok = yield* write("ok.txt", "fine");
      const refused = (paths: ReadonlyArray<string>, id: string) =>
        copy(sharedDir, paths, id).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.include(yield* refused([ok, `${root}/missing.txt`], "m1"), "does not exist");
      assert.include(yield* refused([ok, root], "m2"), "is not a file");
      assert.include(yield* refused(["relative.txt"], "m3"), "not an absolute path");
      const big = yield* sparse("big.bin", TRANSFER_MAX_FILE_BYTES + 1);
      assert.include(yield* refused([ok, big], "m4"), "limit per file");
      const parts = yield* Effect.forEach([1, 2, 3], (n) =>
        sparse(`part${n}.bin`, 90 * 1024 * 1024),
      );
      assert.include(yield* refused(parts, "m5"), "add up to over");
      for (const id of ["m1", "m2", "m3", "m4", "m5"]) {
        assert.isFalse(yield* fs.exists(`${sharedDir}/transfers/asker/${id}`));
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("removes one transfer or an owner's transfers and nothing else under shared/", () =>
  Effect.gen(function* () {
    const { fs, sharedDir, write } = yield* workspace;
    const file = yield* write("a.txt", "a");
    yield* copy(sharedDir, [file], "m1");
    yield* copy(sharedDir, [file], "m2");
    yield* copy(sharedDir, [file], "m3", "other");
    yield* fs.writeFileString(`${sharedDir}/loose.txt`, "x");
    yield* removeTransfer(sharedDir, "asker", "m1");
    assert.isFalse(yield* fs.exists(`${sharedDir}/transfers/asker/m1`));
    assert.isTrue(yield* fs.exists(`${sharedDir}/transfers/asker/m2`));
    yield* removeOwnerTransfers(sharedDir, "asker");
    assert.isFalse(yield* fs.exists(`${sharedDir}/transfers/asker`));
    assert.isTrue(yield* fs.exists(`${sharedDir}/transfers/other/m3`));
    assert.isTrue(yield* fs.exists(`${sharedDir}/loose.txt`));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("lists the copied files for the recipient, and the tool takes at most 10 paths", () => {
  assert.equal(transferText([]), "");
  assert.include(transferText(["/s/a b/a.txt"]), "- [a.txt](</s/a b/a.txt>)");
  const decode = Schema.decodeUnknownExit(OrchestratorMcpThreadSendInput);
  const input = (paths: ReadonlyArray<string>) => ({ threadId: "t", message: "m", paths });
  assert.isTrue(decode(input(Array.from({ length: 10 }, (_, n) => `/f${n}`)))._tag === "Success");
  assert.isTrue(decode(input(Array.from({ length: 11 }, (_, n) => `/f${n}`)))._tag === "Failure");
});
