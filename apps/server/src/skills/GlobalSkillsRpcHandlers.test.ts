import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { makeGlobalSkillsHandlers } from "./GlobalSkillsRpcHandlers.ts";

const settings = { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) };

it.effect("rescan republishes to providers and lists the folder; remove deletes then rescans", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-rpc-" });
    yield* fs.makeDirectory(path.join(root, "one"));
    yield* fs.writeFileString(path.join(root, "one", "SKILL.md"), "First skill");
    let rescans = 0;
    const handlers = makeGlobalSkillsHandlers(root, settings, {
      rescanGlobalSkills: Effect.sync(() => {
        rescans++;
        return [];
      }),
    });

    const listed = yield* handlers.globalSkillsRescan();
    expect(listed.skills.map((skill) => skill.name)).toEqual(["t3:one"]);
    expect(listed.globalSkillsDir).toBe(root);
    expect(rescans).toBe(1);

    const removed = yield* handlers.globalSkillsRemove({ name: "t3:one" });
    expect(removed.skills).toEqual([]);
    expect(rescans).toBe(2);
    expect(yield* fs.exists(path.join(root, "one"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a stable message for a bad name or an unavailable refresh", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-rpc-" });
    const handlers = makeGlobalSkillsHandlers(root, settings, {});
    expect((yield* Effect.flip(handlers.globalSkillsRemove({ name: "t3:../x" }))).message).toBe(
      "Could not remove global skill.",
    );
    expect((yield* Effect.flip(handlers.globalSkillsRescan())).message).toBe(
      "Could not rescan global skills.",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
