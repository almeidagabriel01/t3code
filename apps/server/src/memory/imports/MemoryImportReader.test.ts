import { afterEach, vi } from "@effect/vitest";
import { assert, describe, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk fixture uses Node directly, without application services.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk fixture uses Node directly, without application services.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as Reader from "./MemoryImportReader.ts";
import type { MemoryImportFixture } from "./MemoryImportFixtures.fixture.ts";
import {
  MEMORY_IMPORT_FIXTURE_PROFILES,
  buildMemoryImportFault,
  buildMemoryImportFixture,
  captureMemoryImportInventory,
  makeMemoryImportWorkload,
  snapshotMemoryImportFiles,
} from "./MemoryImportFixtures.fixture.ts";

describe("MemoryImportFixtures frozen API", () => {
  it.effect.each(MEMORY_IMPORT_FIXTURE_PROFILES)("same seed fixes %s bytes and digest", (profile) =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* buildMemoryImportFixture(profile);
        const b = yield* buildMemoryImportFixture(profile);
        const changed = yield* buildMemoryImportFixture(profile, { seed: "different-seed" });
        assert.notEqual(a.sandbox, b.sandbox);
        assert.deepEqual(a.snapshot, b.snapshot);
        assert.notEqual(a.snapshot.snapshotDigest, changed.snapshot.snapshotDigest);
        assert.deepEqual(a.discovered.slot, a.snapshot.slot);
        assert.deepEqual(
          captureMemoryImportInventory(a.sourceRoot),
          captureMemoryImportInventory(b.sourceRoot),
        );
        for (const file of a.snapshot.files) {
          assert.equal(file.byteCount, Buffer.byteLength(file.text));
          assert.equal(
            NodeFS.readFileSync(NodePath.join(a.sourceRoot, file.selector), "utf8"),
            file.text,
          );
        }
      }),
    ),
  );

  it.effect("Scope removes the entire sandbox on success and failure", () =>
    Effect.gen(function* () {
      for (const fail of [false, true]) {
        let sandbox = "";
        const result = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const fixture = yield* buildMemoryImportFixture("claude-topic-v1");
              sandbox = fixture.sandbox;
              assert.ok(NodeFS.existsSync(fixture.sourceRoot));
              assert.ok(NodeFS.existsSync(fixture.stateDir));
              if (fail) return yield* Effect.fail("synthetic failure");
            }),
          ),
        );
        try {
          assert.equal(Exit.isFailure(result), fail);
          assert.notEqual(sandbox, "");
          assert.equal(NodeFS.existsSync(sandbox), false);
        } finally {
          // Keep the red cleanup proof itself from leaking its deliberately broken sandbox.
          if (sandbox) NodeFS.rmSync(sandbox, { recursive: true, force: true });
        }
      }
    }),
  );

  it.effect(
    "negative disk trees preserve their pre-fault snapshot and inventory observes changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const fault of [
            "symlink-root",
            "symlink-ancestor",
            "symlink-file",
            "traversal",
            "malformed-utf8",
            "nul",
            "oversized-file",
            "secret-header",
          ] as const) {
            const fixture = yield* buildMemoryImportFixture("claude-topic-v1");
            const before = captureMemoryImportInventory(fixture.sandbox);
            const snapshot = JSON.stringify(fixture.snapshot);
            const input = buildMemoryImportFault(fixture, fault);
            assert.equal(JSON.stringify(fixture.snapshot), snapshot);
            if (fault === "traversal") assert.equal(input.slot.selection, "../outside");
            else
              assert.notEqual(captureMemoryImportInventory(fixture.sandbox).digest, before.digest);
            if (fault === "malformed-utf8")
              assert.throws(() =>
                new TextDecoder("utf-8", { fatal: true }).decode(
                  NodeFS.readFileSync(NodePath.join(fixture.sourceRoot, "fixture.md")),
                ),
              );
            if (fault === "oversized-file")
              assert.equal(
                NodeFS.readFileSync(NodePath.join(fixture.sourceRoot, "fixture.md")).length,
                262_145,
              );
          }
        }),
      ),
  );

  it.effect("text override and pure snapshot cloning expose exact parser inputs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1", {
          files: { "extensions/ad_hoc/notes/synthetic.md": "Exact synthetic bytes\n" },
        });
        assert.deepEqual(fixture.snapshot.files, [
          {
            selector: "extensions/ad_hoc/notes/synthetic.md",
            text: "Exact synthetic bytes\n",
            byteCount: 22,
          },
        ]);
        const cloned = snapshotMemoryImportFiles(fixture.snapshot, [
          { selector: "../unsafe.md", text: "\0", byteCount: 1 },
        ]);
        assert.notEqual(cloned.snapshotDigest, fixture.snapshot.snapshotDigest);
        assert.equal(cloned.files[0]!.selector, "../unsafe.md");
        assert.equal(fixture.snapshot.files[0]!.text, "Exact synthetic bytes\n");
      }),
    ),
  );

  it("fixes the physical-growth workload at 16 bodies and 64 stable aliases", () => {
    const initial = makeMemoryImportWorkload();
    const changed = makeMemoryImportWorkload(1);
    assert.deepEqual(initial, makeMemoryImportWorkload());
    assert.equal(initial.length, 16);
    assert.equal(new Set(initial.map((item) => item.body)).size, 16);
    assert.equal(new Set(initial.flatMap((item) => item.aliases)).size, 64);
    for (const [index, item] of initial.entries()) {
      assert.equal(Buffer.byteLength(item.body), 4096);
      assert.equal(Buffer.byteLength(changed[index]!.body), 4096);
      assert.notEqual(item.body, changed[index]!.body);
      assert.deepEqual(item.aliases, changed[index]!.aliases);
    }
  });
});

const readerConfig = (
  fixture: MemoryImportFixture,
  root = fixture.trustedRoot,
): Reader.MemoryImportReaderConfig => ({
  stateDir: fixture.stateDir,
  roots: [{ format: fixture.snapshot.format, rootSlot: "fixture-root", path: root }],
});
const residue = (fixture: MemoryImportFixture) =>
  NodeFS.readdirSync(NodePath.join(fixture.stateDir, "memory-import", "snapshots"));

afterEach(() => vi.restoreAllMocks());
const makeSourceSpy = (fixture: MemoryImportFixture, root = fixture.trustedRoot) => {
  const log = { reads: 0, writes: 0 };
  const source = fixture.sourceRoot;
  const check = (path: unknown, write: boolean) => {
    if (typeof path === "string" && (path === source || path.startsWith(`${source}/`))) {
      if (write) {
        log.writes++;
        throw new Error("Source write forbidden");
      }
      log.reads++;
    }
  };
  const original = NodeFS.promises.open.bind(NodeFS.promises);
  vi.spyOn(NodeFS.promises, "open").mockImplementation((path, flags, mode) => {
    check(
      path,
      typeof flags !== "number" ||
        (flags &
          (NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_RDWR |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_TRUNC)) !==
          0,
    );
    return original(path, flags, mode);
  });
  for (const method of [
    "mkdir",
    "unlink",
    "rmdir",
    "writeFile",
    "rm",
    "rename",
    "symlink",
    "copyFile",
    "truncate",
  ] as const) {
    const original = NodeFS.promises[method];
    vi.spyOn(NodeFS.promises, method).mockImplementation((...args: unknown[]) => {
      check(args[0], true);
      if (["rename", "symlink", "copyFile"].includes(method)) check(args[1], true);
      return Reflect.apply(original, NodeFS.promises, args);
    });
  }
  return { config: readerConfig(fixture, root), log };
};
const assertNoSourceWrites = (log: { writes: number }) => assert.equal(log.writes, 0);

describe("MemoryImportReader", () => {
  it.effect.each(MEMORY_IMPORT_FIXTURE_PROFILES)(
    "reads %s without changing original bytes",
    (profile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture(profile);
          const reader = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
          const before = captureMemoryImportInventory(fixture.sourceRoot);
          const value = yield* reader.read({ slot: fixture.snapshot.slot });
          assert.deepEqual(value.files, fixture.snapshot.files);
          assert.equal(value.profile, profile);
          assert.equal(value.sourceLocator.includes(fixture.sandbox), false);
          assert.equal("sourceId" in value, false);
          assert.equal("environmentId" in value, false);
          assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
          assert.deepEqual(residue(fixture), []);
          const discovered = yield* reader.discover({ format: fixture.snapshot.format });
          assert.equal(discovered.length, 1);
          assert.deepEqual(discovered[0]!.slot, fixture.snapshot.slot);
          assert.equal(discovered[0]!.parserVersion, profile);
          assert.equal(
            discovered[0]!.label,
            fixture.snapshot.slot.selection ?? fixture.snapshot.slot.rootSlot,
          );
          assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
          assert.deepEqual(residue(fixture), []);
        }),
      ),
  );

  const faults = [
    ["symlink-root", "path_rejected"],
    ["symlink-ancestor", "path_rejected"],
    ["symlink-file", "path_rejected"],
    ["traversal", "path_rejected"],
    ["malformed-utf8", "invalid_utf8"],
    ["nul", "path_rejected"],
    ["oversized-file", "limit_exceeded"],
    ["secret-header", "secret_detected"],
  ] as const;
  it.effect.each(faults)("refuses %s with no source changes", ([fault, issue]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const input = buildMemoryImportFault(fixture, fault);
        const spy = makeSourceSpy(fixture, input.root);
        const reader = yield* Reader.acquireMemoryImportReader(spy.config);
        const before = captureMemoryImportInventory(fixture.sandbox).entries;
        const failure = yield* Effect.flip(reader.read({ slot: input.slot }));
        assert.equal(failure.issue, issue);
        assert.equal(failure.message.includes(fixture.sandbox), false);
        assert.deepEqual(captureMemoryImportInventory(fixture.sandbox).entries, before);
        assertNoSourceWrites(spy.log);
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );

  it.effect("accepts exactly 256 KiB, refuses +1 without partial text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1", {
          files: { "extensions/ad_hoc/notes/equal.md": "a".repeat(262144) },
        });
        const reader = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
        assert.equal(
          (yield* reader.read({ slot: fixture.snapshot.slot })).files[0]!.byteCount,
          262144,
        );
        NodeFS.appendFileSync(
          NodePath.join(fixture.sourceRoot, "extensions/ad_hoc/notes/equal.md"),
          "a",
        );
        const before = captureMemoryImportInventory(fixture.sourceRoot);
        assert.equal(
          (yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot }))).issue,
          "limit_exceeded",
        );
        assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );

  it.effect("counts excluded entries at equality and +1", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        // Three builder files plus 509 excluded entries = 512 visited entries.
        for (let i = 0; i < 509; i++)
          NodeFS.writeFileSync(NodePath.join(fixture.sourceRoot, `excluded-${i}`), "");
        const reader = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
        assert.equal((yield* reader.read({ slot: fixture.snapshot.slot })).files.length, 1);
        NodeFS.writeFileSync(NodePath.join(fixture.sourceRoot, "excluded-plus-one"), "");
        assert.equal(
          (yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot }))).issue,
          "limit_exceeded",
        );
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );

  it.effect("bounds traversal depth at equality and +1 even for excluded directories", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const path = NodePath.join(
          fixture.sourceRoot,
          ...Array.from({ length: 7 }, () => "nested"),
        );
        NodeFS.mkdirSync(path, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(path, "leaf"), "");
        const reader = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
        yield* reader.read({ slot: fixture.snapshot.slot });
        NodeFS.mkdirSync(NodePath.join(path, "one-more"));
        NodeFS.writeFileSync(NodePath.join(path, "one-more", "leaf"), "");
        assert.equal(
          (yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot }))).issue,
          "limit_exceeded",
        );
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );

  it.effect(
    "reserves two slots before allocation, refuses a third and shares accounting across readers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
          const a = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
          const b = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
          const before = captureMemoryImportInventory(fixture.sourceRoot);
          const results = yield* Effect.forEach(
            [a, b, a],
            (reader) => Effect.result(reader.read({ slot: fixture.snapshot.slot })),
            { concurrency: "unbounded" },
          );
          assert.equal(results.filter((value) => value._tag === "Success").length, 2);
          const failures = results.filter((value) => value._tag === "Failure");
          assert.equal(failures.length, 1);
          assert.equal(
            failures[0]!._tag === "Failure" && failures[0]!.failure.issue,
            "limit_exceeded",
          );
          assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
          assert.deepEqual(residue(fixture), []);
          yield* a.read({ slot: fixture.snapshot.slot });
        }),
      ),
  );

  it.effect("interruption releases all owned snapshots before returning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const spy = makeSourceSpy(fixture);
        const started = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        let paused = false;
        const reader = yield* Reader.acquireMemoryImportReader({
          ...spy.config,
          onSnapshotSealed: () =>
            Effect.gen(function* () {
              if (paused) return;
              paused = true;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(proceed);
            }),
        });
        const before = captureMemoryImportInventory(fixture.sourceRoot);
        const fiber = yield* Effect.forkChild(reader.read({ slot: fixture.snapshot.slot }));
        yield* Deferred.await(started);
        assert.equal(residue(fixture).length, 1);
        yield* Fiber.interrupt(fiber);
        assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
        assert.deepEqual(residue(fixture), []);
        assertNoSourceWrites(spy.log);
        yield* reader.read({ slot: fixture.snapshot.slot });
      }),
    ),
  );

  it.effect("closed acquisition cannot be reused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const reader = yield* Effect.scoped(
          Reader.acquireMemoryImportReader(readerConfig(fixture)),
        );
        assert.equal(
          (yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot }))).issue,
          "source_unreadable",
        );
      }),
    ),
  );

  it.effect(
    "startup removes bounded residue and rejects foreign entries or symlink ancestors",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
          const config = readerConfig(fixture);
          yield* Reader.cleanupMemoryImportSnapshots(config);
          const base = NodePath.join(fixture.stateDir, "memory-import", "snapshots");
          const old = NodePath.join(base, "snapshot-00000000-0000-0000-0000-000000000000");
          NodeFS.mkdirSync(old, { mode: 0o700 });
          NodeFS.writeFileSync(NodePath.join(old, "raw"), "Synthetic residue", { mode: 0o600 });
          yield* Reader.cleanupMemoryImportSnapshots(config);
          assert.deepEqual(residue(fixture), []);
          NodeFS.symlinkSync(
            fixture.sourceRoot,
            NodePath.join(base, "snapshot-00000000-0000-0000-0000-000000000000"),
          );
          const before = captureMemoryImportInventory(fixture.sourceRoot);
          assert.equal(
            (yield* Effect.flip(Reader.cleanupMemoryImportSnapshots(config))).issue,
            "path_rejected",
          );
          assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
        }),
      ),
  );

  it.effect("startup cannot clean active readers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const config = readerConfig(fixture);
        yield* Reader.acquireMemoryImportReader(config);
        assert.equal(
          (yield* Effect.flip(Reader.cleanupMemoryImportSnapshots(config))).issue,
          "source_unreadable",
        );
      }),
    ),
  );

  it.effect("acquisition Scope closes an in-flight copy and waits for cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const scope = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const reader = yield* Reader.acquireMemoryImportReader({
          ...readerConfig(fixture),
          onSnapshotSealed: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        }).pipe(Scope.provide(scope));
        const before = captureMemoryImportInventory(fixture.sourceRoot);
        const fiber = yield* Effect.forkChild(reader.read({ slot: fixture.snapshot.slot }));
        yield* Deferred.await(started);
        yield* Scope.close(scope, Exit.void);
        assert.equal(Exit.isFailure(yield* Fiber.await(fiber)), true);
        assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );

  it.effect("cleanup failure retains the reservation and disables subsequent reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const config = {
          ...readerConfig(fixture),
          onSnapshotSealed: () =>
            Effect.sync(() => {
              const base = NodePath.join(fixture.stateDir, "memory-import", "snapshots");
              for (const name of NodeFS.readdirSync(base))
                NodeFS.chmodSync(NodePath.join(base, name), 0o755);
            }),
        };
        const reader = yield* Reader.acquireMemoryImportReader(config);
        const before = captureMemoryImportInventory(fixture.sourceRoot);
        assert.equal(
          (yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot }))).issue,
          "source_unreadable",
        );
        assert.equal(residue(fixture).length, 1);
        assert.equal(
          (yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot }))).issue,
          "source_unreadable",
        );
        assert.equal(residue(fixture).length, 1);
        assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
        // The fixture's outer Scope removes this deliberately unsafe residue; product admission stays closed.
      }),
    ),
  );

  it.effect("acquisition root admission accepts 128 and refuses +1", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const config = readerConfig(fixture);
        const roots = Array.from({ length: 128 }, (_, i) => ({
          ...config.roots[0]!,
          rootSlot: `slot-${i}`,
        }));
        yield* Reader.acquireMemoryImportReader({ ...config, roots });
        assert.equal(
          (yield* Effect.flip(
            Reader.acquireMemoryImportReader({
              ...config,
              roots: [...roots, { ...roots[0]!, rootSlot: "plus-one" }],
            }),
          )).issue,
          "limit_exceeded",
        );
      }),
    ),
  );

  it.effect.each(MEMORY_IMPORT_FIXTURE_PROFILES)(
    "Node source write spy stays zero for %s",
    (profile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture(profile);
          const { config, log } = makeSourceSpy(fixture);
          const reader = yield* Reader.acquireMemoryImportReader(config);
          const before = captureMemoryImportInventory(fixture.sourceRoot);
          const readExit = yield* Effect.exit(reader.read({ slot: fixture.snapshot.slot }));
          assert.isTrue(Exit.isSuccess(readExit));
          assertNoSourceWrites(log);
          assert.isAbove(log.reads, 0);
          assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
          assert.deepEqual(residue(fixture), []);
        }),
      ),
  );

  it.effect.each(["claude-topic-v1"] as const)(
    "discover retains the source listing stamp through child stat for %s",
    (profile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* buildMemoryImportFixture(profile);
          const reader = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
          const target = NodePath.dirname(fixture.sourceRoot);
          const lstat = NodeFS.promises.lstat;
          let mutated = false;
          vi.spyOn(NodeFS.promises, "lstat").mockImplementation(async (...args) => {
            if (args[0] === target && !mutated) {
              mutated = true;
              NodeFS.mkdirSync(NodePath.join(fixture.trustedRoot, "new-selection"));
            }
            return lstat(...args);
          });
          const failure = yield* Effect.flip(reader.discover({ format: fixture.snapshot.format }));
          assert.equal(mutated, true);
          assert.equal(failure.issue, "source_changed");
          assert.deepEqual(Object.keys(failure).sort(), ["_tag", "issue"]);
          assert.deepEqual(residue(fixture), []);
        }),
      ),
  );

  it.effect("discover skips symlinked and memoryless Claude projects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("claude-topic-v1");
        const reader = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
        NodeFS.mkdirSync(NodePath.join(fixture.trustedRoot, "no-memory"));
        NodeFS.mkdirSync(NodePath.join(fixture.trustedRoot, "empty", "memory"), {
          recursive: true,
        });
        NodeFS.symlinkSync(
          NodePath.dirname(fixture.sourceRoot),
          NodePath.join(fixture.trustedRoot, "moved"),
        );
        const discovered = yield* reader.discover({ format: fixture.snapshot.format });
        assert.deepEqual(
          discovered.map((source) => source.slot),
          [fixture.snapshot.slot],
        );
      }),
    ),
  );

  it.effect("listed file disappearance before first stat is source_changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const reader = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
        const target = NodePath.join(fixture.sourceRoot, "MEMORY.md");
        const lstat = NodeFS.promises.lstat;
        let removed = false;
        vi.spyOn(NodeFS.promises, "lstat").mockImplementation(async (...args) => {
          if (args[0] === target && !removed) {
            removed = true;
            NodeFS.unlinkSync(target);
          }
          return lstat(...args);
        });
        const failure = yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot }));
        assert.equal(removed, true);
        assert.equal(failure.issue, "source_changed");
        assert.deepEqual(Object.keys(failure).sort(), ["_tag", "issue"]);
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );

  it.effect("initially absent source root remains source_missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("claude-topic-v1");
        const reader = yield* Reader.acquireMemoryImportReader(
          readerConfig(fixture, NodePath.join(fixture.sandbox, "absent-root")),
        );
        const failure = yield* Effect.flip(reader.discover({ format: fixture.snapshot.format }));
        assert.equal(failure.issue, "source_missing");
        assert.deepEqual(Object.keys(failure).sort(), ["_tag", "issue"]);
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );

  it.effect("Node restat rejects a transient source rewrite without returning bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const file = NodePath.join(fixture.sourceRoot, "MEMORY.md");
        const original = NodeFS.readFileSync(file);
        let mutated = false;
        const reader = yield* Reader.acquireMemoryImportReader({
          ...readerConfig(fixture),
          onSourceRead: () => {
            if (mutated) return;
            mutated = true;
            NodeFS.writeFileSync(file, Buffer.concat([original, Buffer.from("changed")]));
            NodeFS.writeFileSync(file, original);
          },
        });
        const before = captureMemoryImportInventory(fixture.sourceRoot);
        assert.equal(
          (yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot }))).issue,
          "source_changed",
        );
        assert.equal(mutated, true);
        assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );

  it.effect("ancestor swap during a source read fails closed with source_changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const ancestor = NodePath.join(fixture.sandbox, "trusted");
        const saved = NodePath.join(fixture.sandbox, "saved-trusted");
        let swapped = false;
        const reader = yield* Reader.acquireMemoryImportReader({
          ...readerConfig(fixture),
          onSourceRead: () => {
            if (swapped) return;
            swapped = true;
            NodeFS.renameSync(ancestor, saved);
            NodeFS.symlinkSync(saved, ancestor);
          },
        });
        const before = captureMemoryImportInventory(fixture.sourceRoot);
        const failure = yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot })).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (swapped) {
                NodeFS.unlinkSync(ancestor);
                NodeFS.renameSync(saved, ancestor);
              }
            }),
          ),
        );
        assert.equal(swapped, true);
        assert.equal(failure.issue, "source_changed");
        assert.deepEqual(Object.keys(failure).sort(), ["_tag", "issue"]);
        assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );
  it.effect("64 MiB startup residue equality is removed and +1 is left untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const config = readerConfig(fixture);
        yield* Reader.cleanupMemoryImportSnapshots(config);
        const base = NodePath.join(fixture.stateDir, "memory-import", "snapshots");
        const old = NodePath.join(base, "snapshot-00000000-0000-0000-0000-000000000000");
        NodeFS.mkdirSync(old, { mode: 0o700 });
        NodeFS.writeFileSync(NodePath.join(old, "raw"), "", { mode: 0o600 });
        NodeFS.truncateSync(NodePath.join(old, "raw"), 67108864);
        yield* Reader.cleanupMemoryImportSnapshots(config);
        assert.deepEqual(residue(fixture), []);
        NodeFS.mkdirSync(old, { mode: 0o700 });
        NodeFS.writeFileSync(NodePath.join(old, "raw"), "", { mode: 0o600 });
        NodeFS.truncateSync(NodePath.join(old, "raw"), 67108865);
        assert.equal(
          (yield* Effect.flip(Reader.cleanupMemoryImportSnapshots(config))).issue,
          "limit_exceeded",
        );
        assert.equal(NodeFS.statSync(NodePath.join(old, "raw")).size, 67108865);
      }),
    ),
  );

  it.effect("UTF-8 source aggregate accepts 8 MiB and refuses +1 before retaining text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = Object.fromEntries(
          Array.from({ length: 32 }, (_, i) => [
            `extensions/ad_hoc/notes/n${i}.md`,
            "가".repeat(87381) + "a",
          ]),
        );
        const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1", { files });
        const reader = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
        const value = yield* reader.read({ slot: fixture.snapshot.slot });
        assert.equal(
          value.files.reduce((n, f) => n + f.byteCount, 0),
          8388608,
        );
        NodeFS.writeFileSync(
          NodePath.join(fixture.sourceRoot, "extensions", "ad_hoc", "notes", "extra.md"),
          "a",
        );
        const before = captureMemoryImportInventory(fixture.sourceRoot);
        assert.equal(
          (yield* Effect.flip(reader.read({ slot: fixture.snapshot.slot }))).issue,
          "limit_exceeded",
        );
        assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );

  it.effect("stateDir/source overlap is rejected before any snapshot directory write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-handbook-v1");
        const config = { ...readerConfig(fixture), stateDir: fixture.sourceRoot };
        const before = captureMemoryImportInventory(fixture.sourceRoot);
        assert.equal(
          (yield* Effect.flip(Reader.cleanupMemoryImportSnapshots(config))).issue,
          "path_rejected",
        );
        assert.equal(
          (yield* Effect.flip(Reader.acquireMemoryImportReader(config))).issue,
          "path_rejected",
        );
        assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
      }),
    ),
  );

  it.effect("UTF-8 decoding preserves BOM bytes and the original byte count", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1", {
          files: { "extensions/ad_hoc/notes/bom.md": "\uFEFFSynthetic fixture text\n" },
        });
        const reader = yield* Reader.acquireMemoryImportReader(readerConfig(fixture));
        const before = captureMemoryImportInventory(fixture.sourceRoot);
        const value = yield* reader.read({ slot: fixture.snapshot.slot });
        assert.deepEqual(value.files, fixture.snapshot.files);
        assert.equal(Buffer.byteLength(value.files[0]!.text), value.files[0]!.byteCount);
        assert.deepEqual(captureMemoryImportInventory(fixture.sourceRoot), before);
        assert.deepEqual(residue(fixture), []);
      }),
    ),
  );
});
