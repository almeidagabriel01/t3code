// @effect-diagnostics nodeBuiltinImport:off - fixtures build links and read raw bytes synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ProjectEntryChange } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceEntryChanges from "./WorkspaceEntryChanges.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceTrash from "./WorkspaceTrash.ts";

const UNKNOWN = "t3-unknown-project-";

const setup = Effect.fn("setup")(function* (options: { readonly trash?: boolean } = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const base = NodeFS.realpathSync(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-entry-changes-" }),
  );
  const cwd = NodePath.join(base, "project");
  const outside = NodePath.join(base, "outside");
  const trashDir = NodePath.join(base, "trash");
  NodeFS.mkdirSync(cwd);
  NodeFS.mkdirSync(outside);
  NodeFS.writeFileSync(NodePath.join(outside, "secret.txt"), "secret");
  const refreshed: string[] = [];
  const service = yield* WorkspaceEntryChanges.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          WorkspaceTrash.WorkspaceTrash,
          WorkspaceTrash.makeAt(
            options.trash === false ? null : { filesDir: trashDir, infoDir: null },
          ),
        ),
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({
          assertContains: (root) =>
            root.includes(UNKNOWN)
              ? Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd: root }))
              : Effect.void,
        }),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({
          refresh: (root) => Effect.sync(() => void refreshed.push(root)),
        }),
        WorkspacePaths.layer,
      ),
    ),
  );
  const change = (entry: ProjectEntryChange, root = cwd) =>
    service.changeEntry({ cwd: root, change: entry });
  const failureOf = (entry: ProjectEntryChange, root = cwd) =>
    change(entry, root).pipe(
      Effect.flip,
      Effect.map((error) => error.failure),
    );
  const file = (relativePath: string, contents = "") => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, relativePath)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, relativePath), contents);
  };
  const exists = (relativePath: string) => NodeFS.existsSync(NodePath.join(cwd, relativePath));
  const read = (relativePath: string) =>
    NodeFS.readFileSync(NodePath.join(cwd, relativePath), "utf8");
  return { cwd, outside, trashDir, change, failureOf, file, exists, read, refreshed };
});

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

describe("WorkspaceEntryChanges", () => {
  describe("path confinement", () => {
    const escapes = [
      "../escape.txt",
      "a/../../escape.txt",
      "..",
      "a/..",
      "/etc/passwd",
      "src/../../../escape",
    ];
    it.effect.each(escapes)("refuses '%s' for every change", (relativePath) =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          t.file("keep.txt");
          for (const change of [
            { _tag: "create", relativePath, kind: "file" },
            { _tag: "move", relativePath: "keep.txt", newRelativePath: relativePath },
            { _tag: "move", relativePath, newRelativePath: "moved.txt" },
            { _tag: "duplicate", relativePath },
            { _tag: "delete", relativePaths: [relativePath], mode: "permanent" },
            { _tag: "import", relativePath, contentsBase64: "" },
          ] satisfies ProjectEntryChange[]) {
            expect(yield* t.failureOf(change)).toBe("outside_root");
          }
          expect(t.exists("keep.txt")).toBe(true);
        }),
      ),
    );

    const gitPaths = [".git", ".git/config", ".git/hooks/pre-commit", "sub/.GIT/x", ".git./x"];
    it.effect.each(gitPaths)("refuses git metadata '%s'", (relativePath) =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          t.file(".git/config", "[core]");
          t.file("keep.txt");
          expect(yield* t.failureOf({ _tag: "create", relativePath, kind: "file" })).toBe(
            "invalid_target",
          );
          expect(
            yield* t.failureOf({
              _tag: "delete",
              relativePaths: [relativePath],
              mode: "permanent",
            }),
          ).toBe("invalid_target");
          expect(
            yield* t.failureOf({
              _tag: "move",
              relativePath: "keep.txt",
              newRelativePath: relativePath,
            }),
          ).toBe("invalid_target");
          expect(t.read(".git/config")).toBe("[core]");
        }),
      ),
    );

    it.effect("refuses a project the server does not know", () =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          expect(
            yield* t.failureOf(
              { _tag: "create", relativePath: "a.txt", kind: "file" },
              NodePath.join(t.cwd, `${UNKNOWN}x`),
            ),
          ).toBe("outside_root");
        }),
      ),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never writes through a folder link that leaves the project",
      () =>
        provided(
          Effect.gen(function* () {
            const t = yield* setup();
            NodeFS.symlinkSync(t.outside, NodePath.join(t.cwd, "linkOut"));
            NodeFS.symlinkSync(NodePath.join(t.cwd, "missing"), NodePath.join(t.cwd, "dangling"));
            t.file("keep.txt");
            for (const relativePath of ["linkOut/new.txt", "linkOut/secret.txt", "dangling/x"]) {
              expect(yield* t.failureOf({ _tag: "create", relativePath, kind: "file" })).not.toBe(
                undefined,
              );
              yield* t.failureOf({
                _tag: "move",
                relativePath: "keep.txt",
                newRelativePath: relativePath,
              });
              yield* t.failureOf({
                _tag: "delete",
                relativePaths: [relativePath],
                mode: "permanent",
              });
            }
            expect(
              yield* t.failureOf({ _tag: "create", relativePath: "linkOut/new.txt", kind: "file" }),
            ).toBe("outside_root");
            expect(
              yield* t.failureOf({
                _tag: "delete",
                relativePaths: ["linkOut/secret.txt"],
                mode: "permanent",
              }),
            ).toBe("outside_root");
            expect(NodeFS.readdirSync(t.outside)).toEqual(["secret.txt"]);
            expect(t.exists("keep.txt")).toBe(true);
          }),
        ),
    );

    it.effect.skipIf(!symlinksSupported)(
      "deletes a link that points outside without touching its target",
      () =>
        provided(
          Effect.gen(function* () {
            for (const mode of ["permanent", "trash"] as const) {
              const t = yield* setup();
              NodeFS.symlinkSync(t.outside, NodePath.join(t.cwd, "linkDir"));
              NodeFS.symlinkSync(
                NodePath.join(t.outside, "secret.txt"),
                NodePath.join(t.cwd, "linkFile"),
              );
              const result = yield* t.change({
                _tag: "delete",
                relativePaths: ["linkDir", "linkFile"],
                mode,
              });
              expect(result.entries.map((entry) => entry.relativePath).toSorted()).toEqual([
                "linkDir",
                "linkFile",
              ]);
              expect(NodeFS.readFileSync(NodePath.join(t.outside, "secret.txt"), "utf8")).toBe(
                "secret",
              );
              expect(NodeFS.existsSync(NodePath.join(t.cwd, "linkDir"))).toBe(false);
            }
          }),
        ),
    );
  });

  describe("create and import", () => {
    it.effect("creates nested files and folders and refuses existing names", () =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          expect(
            yield* t.change({ _tag: "create", relativePath: "src/utils/a.ts", kind: "file" }),
          ).toEqual({ entries: [{ relativePath: "src/utils/a.ts" }], failures: [] });
          expect(t.read("src/utils/a.ts")).toBe("");
          yield* t.change({ _tag: "create", relativePath: "docs", kind: "directory" });
          expect(NodeFS.statSync(NodePath.join(t.cwd, "docs")).isDirectory()).toBe(true);
          for (const relativePath of ["src/utils/a.ts", "docs", "src"]) {
            expect(yield* t.failureOf({ _tag: "create", relativePath, kind: "file" })).toBe(
              "already_exists",
            );
            expect(yield* t.failureOf({ _tag: "create", relativePath, kind: "directory" })).toBe(
              "already_exists",
            );
          }
          expect(t.refreshed).toEqual([t.cwd, t.cwd]);
        }),
      ),
    );

    it.effect("imports bytes and gives a taken name a copy suffix", () =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          t.file("assets/logo.png", "old");
          const bytes = Buffer.from([0, 1, 2, 255]);
          const result = yield* t.change({
            _tag: "import",
            relativePath: "assets/logo.png",
            contentsBase64: bytes.toString("base64"),
          });
          expect(result.entries).toEqual([{ relativePath: "assets/logo copy.png" }]);
          expect(NodeFS.readFileSync(NodePath.join(t.cwd, "assets/logo copy.png"))).toEqual(bytes);
          expect(t.read("assets/logo.png")).toBe("old");
          const fresh = yield* t.change({
            _tag: "import",
            relativePath: "new/readme.md",
            contentsBase64: Buffer.from("# hi").toString("base64"),
          });
          expect(fresh.entries).toEqual([{ relativePath: "new/readme.md" }]);
          expect(
            yield* t.failureOf({
              _tag: "import",
              relativePath: "big.bin",
              contentsBase64: Buffer.alloc(25 * 1024 * 1024 + 3).toString("base64"),
            }),
          ).toBe("too_large");
        }),
      ),
    );
  });

  describe("move and duplicate", () => {
    it.effect("renames and moves, retries safely, and refuses collisions and cycles", () =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          t.file("a.ts", "a");
          t.file("b.ts", "b");
          t.file("dir/inner.ts", "inner");
          const rename = {
            _tag: "move",
            relativePath: "a.ts",
            newRelativePath: "lib/c.ts",
          } as const;
          expect((yield* t.change(rename)).entries).toEqual([{ relativePath: "lib/c.ts" }]);
          expect(t.read("lib/c.ts")).toBe("a");
          // The retry of a move that landed reports the same result.
          expect((yield* t.change(rename)).entries).toEqual([{ relativePath: "lib/c.ts" }]);
          expect(
            yield* t.failureOf({ _tag: "move", relativePath: "b.ts", newRelativePath: "lib/c.ts" }),
          ).toBe("already_exists");
          expect(
            yield* t.failureOf({
              _tag: "move",
              relativePath: "dir",
              newRelativePath: "dir/sub/dir",
            }),
          ).toBe("invalid_target");
          expect(
            yield* t.failureOf({ _tag: "move", relativePath: "gone", newRelativePath: "x" }),
          ).toBe("not_found");
          expect(t.read("b.ts")).toBe("b");
        }),
      ),
    );

    it.effect("renames by case alone on a case-insensitive volume", () =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          t.file("Foo.ts", "x");
          const result = yield* t.change({
            _tag: "move",
            relativePath: "Foo.ts",
            newRelativePath: "foo.ts",
          });
          expect(result.entries).toEqual([{ relativePath: "foo.ts" }]);
          expect(NodeFS.readdirSync(t.cwd)).toEqual(["foo.ts"]);
        }),
      ),
    );

    it.effect("duplicates files and folders with copy names and copies links as links", () =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          t.file("src/report.ts", "r");
          t.file("src/.env", "e");
          t.file("pkg/index.ts", "i");
          if (symlinksSupported) {
            NodeFS.symlinkSync(t.outside, NodePath.join(t.cwd, "pkg/out"));
          }
          const duplicate = (relativePath: string) =>
            t
              .change({ _tag: "duplicate", relativePath })
              .pipe(Effect.map((result) => result.entries[0]?.relativePath));
          expect(yield* duplicate("src/report.ts")).toBe("src/report copy.ts");
          expect(yield* duplicate("src/report.ts")).toBe("src/report copy 2.ts");
          expect(yield* duplicate("src/.env")).toBe("src/.env copy");
          expect(yield* duplicate("pkg")).toBe("pkg copy");
          expect(t.read("pkg copy/index.ts")).toBe("i");
          if (symlinksSupported) {
            expect(NodeFS.lstatSync(NodePath.join(t.cwd, "pkg copy/out")).isSymbolicLink()).toBe(
              true,
            );
          }
          expect(yield* t.failureOf({ _tag: "duplicate", relativePath: "nope" })).toBe("not_found");
        }),
      ),
    );
  });

  describe("delete and restore", () => {
    it.effect("trashes with restore tokens and puts entries back", () =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          t.file("dir/a.ts", "a");
          t.file("b.ts", "b");
          const deleted = yield* t.change({
            _tag: "delete",
            relativePaths: ["dir", "dir/a.ts", "b.ts", "missing.ts"],
            mode: "trash",
          });
          // A selected child goes with its folder, and a missing entry is already gone.
          expect(deleted.entries.map((entry) => entry.relativePath)).toEqual(["dir", "b.ts"]);
          expect(t.exists("dir") || t.exists("b.ts")).toBe(false);
          expect(NodeFS.readdirSync(t.trashDir).toSorted()).toEqual(["b.ts", "dir"]);
          const tokens = deleted.entries.map((entry) => entry.restoreToken!);
          t.file("b.ts", "new b");
          expect(yield* t.failureOf({ _tag: "restore", restoreTokens: tokens })).toBe(
            "already_exists",
          );
          expect(t.exists("dir")).toBe(false);
          NodeFS.rmSync(NodePath.join(t.cwd, "b.ts"));
          const restored = yield* t.change({ _tag: "restore", restoreTokens: tokens });
          expect(restored.entries.map((entry) => entry.relativePath)).toEqual(["dir", "b.ts"]);
          expect(t.read("dir/a.ts")).toBe("a");
          // A token puts back once.
          expect(yield* t.failureOf({ _tag: "restore", restoreTokens: tokens })).toBe("not_found");
        }),
      ),
    );

    it.effect("restore tokens belong to the project that issued them", () =>
      provided(
        Effect.gen(function* () {
          const t = yield* setup();
          t.file("a.ts");
          const deleted = yield* t.change({
            _tag: "delete",
            relativePaths: ["a.ts"],
            mode: "trash",
          });
          const other = NodePath.join(t.cwd, "nested-project");
          NodeFS.mkdirSync(other);
          expect(
            yield* t.failureOf(
              { _tag: "restore", restoreTokens: [deleted.entries[0]!.restoreToken!] },
              other,
            ),
          ).toBe("not_found");
          expect(yield* t.failureOf({ _tag: "restore", restoreTokens: ["forged-token"] })).toBe(
            "not_found",
          );
        }),
      ),
    );

    it.effect(
      "reports an unavailable trash before touching anything, then deletes permanently",
      () =>
        provided(
          Effect.gen(function* () {
            const t = yield* setup({ trash: false });
            t.file("a.ts");
            t.file("dir/b.ts");
            expect(
              yield* t.failureOf({ _tag: "delete", relativePaths: ["a.ts", "dir"], mode: "trash" }),
            ).toBe("trash_unavailable");
            expect(t.exists("a.ts") && t.exists("dir/b.ts")).toBe(true);
            const deleted = yield* t.change({
              _tag: "delete",
              relativePaths: ["a.ts", "dir"],
              mode: "permanent",
            });
            expect(deleted).toEqual({
              entries: [{ relativePath: "a.ts" }, { relativePath: "dir" }],
              failures: [],
            });
            expect(t.exists("a.ts") || t.exists("dir")).toBe(false);
          }),
        ),
    );
  });

  it("names copies like Finder", () => {
    expect(WorkspaceEntryChanges.copyName("a.tar.gz", false, 1)).toBe("a.tar copy.gz");
    expect(WorkspaceEntryChanges.copyName("Makefile", false, 3)).toBe("Makefile copy 3");
    expect(WorkspaceEntryChanges.copyName("v1.2", true, 2)).toBe("v1.2 copy 2");
  });
});
