// @effect-diagnostics nodeBuiltinImport:off - fixtures inspect the trash folders synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as WorkspaceTrash from "./WorkspaceTrash.ts";

const tempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return NodeFS.realpathSync(yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trash-" }));
});

describe("WorkspaceTrash", () => {
  it.effect("keeps freedesktop records, picks free names and puts entries back", () =>
    Effect.gen(function* () {
      const base = yield* tempDir;
      const trashRoot = NodePath.join(base, "Trash");
      const trash = WorkspaceTrash.makeAt({
        filesDir: NodePath.join(trashRoot, "files"),
        infoDir: NodePath.join(trashRoot, "info"),
      });
      const first = NodePath.join(base, "dir one", "notes.md");
      const second = NodePath.join(base, "notes.md");
      NodeFS.mkdirSync(NodePath.dirname(first), { recursive: true });
      NodeFS.writeFileSync(first, "1");
      NodeFS.writeFileSync(second, "2");

      const one = yield* trash.moveToTrash(first);
      const two = yield* trash.moveToTrash(second);
      expect(NodePath.basename(one.trashedPath)).toBe("notes.md");
      expect(NodePath.basename(two.trashedPath)).toMatch(/^notes \d+-1\.md$/);
      const info = NodeFS.readFileSync(one.infoPath!, "utf8");
      expect(info).toContain("[Trash Info]\nPath=");
      expect(info).toContain("/dir%20one/notes.md\n");
      expect(info).toMatch(/DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);

      yield* trash.putBack(one, first);
      expect(NodeFS.readFileSync(first, "utf8")).toBe("1");
      expect(NodeFS.existsSync(one.infoPath!)).toBe(false);
      const failed = yield* trash.moveToTrash(NodePath.join(base, "missing")).pipe(Effect.flip);
      expect(failed._tag).toBe("WorkspaceTrashOperationError");
      expect(NodeFS.readdirSync(NodePath.join(trashRoot, "info"))).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("chooses the trash for each platform and has none on Windows", () =>
    Effect.gen(function* () {
      const home = yield* tempDir;
      const file = NodePath.join(home, "a.txt");
      const trashed = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) =>
        Effect.gen(function* () {
          NodeFS.writeFileSync(file, "a");
          const trash = yield* WorkspaceTrash.make;
          return yield* trash.moveToTrash(file);
        }).pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, env),
        );
      expect((yield* trashed("darwin")).trashedPath).toBe(NodePath.join(home, ".Trash", "a.txt"));
      expect((yield* trashed("linux")).trashedPath).toBe(
        NodePath.join(home, ".local/share/Trash/files/a.txt"),
      );
      const custom = NodePath.join(home, "data");
      expect((yield* trashed("linux", { XDG_DATA_HOME: custom })).trashedPath).toBe(
        NodePath.join(custom, "Trash/files/a.txt"),
      );
      const windows = yield* trashed("win32").pipe(Effect.flip);
      expect(windows._tag).toBe("WorkspaceTrashUnavailableError");
      expect(windows.message).toContain("no supported trash");
      expect(NodeFS.existsSync(file)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
