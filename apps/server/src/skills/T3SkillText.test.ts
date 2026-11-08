import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { providerTextWithSkills } from "./T3SkillText.ts";

it.effect("delivers an enabled T3 skill read at send time", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-turn-skills-" });
    const dir = path.join(root, "one");
    yield* fs.makeDirectory(dir);
    yield* fs.writeFileString(path.join(dir, "SKILL.md"), "first instructions");
    const send = (text: string, current: ServerSettings = DEFAULT_SERVER_SETTINGS) =>
      providerTextWithSkills(Option.some({ getSettings: Effect.succeed(current) }), {
        text,
        globalSkillsDir: root,
      });
    expect(yield* send("do $t3:one")).toContain('name="t3:one"');
    yield* fs.writeFileString(path.join(dir, "SKILL.md"), "updated instructions");
    expect(yield* send("do $t3:one")).toContain("updated instructions");
    expect(
      yield* send("do $t3:one", {
        ...DEFAULT_SERVER_SETTINGS,
        disabledGlobalSkills: ["t3:one"],
      }),
    ).toBe("do $t3:one");
    expect(yield* send("no skill here")).toBe("no skill here");
    expect(yield* send("/native $t3:one")).toBe("/native $t3:one");
    expect(
      yield* providerTextWithSkills(Option.none(), { text: "do $t3:one", globalSkillsDir: root }),
    ).toBe("do $t3:one");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
