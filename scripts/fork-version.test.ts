import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import { releasePackageFiles } from "./update-release-package-versions.ts";

import {
  bumpForkVersion,
  nextForkVersion,
  parseArgs,
  setMobileForkVersion,
} from "./fork-version.ts";

describe("nextForkVersion", () => {
  it.each([
    ["0.1.6-fork.1", undefined, "0.1.6-fork.2"],
    ["0.1.6-fork.9", undefined, "0.1.6-fork.10"],
    ["0.1.5", undefined, "0.1.5-fork.1"],
    ["0.1.6-fork.3", "0.1.7", "0.1.7-fork.1"],
    ["0.1.6-fork.3", "0.1.6", "0.1.6-fork.4"],
    ["0.1.6-fork.3", "0.2.0", "0.2.0-fork.1"],
    ["0.1.5", "0.1.5", "0.1.5-fork.1"],
  ])("%s with base %s -> %s", (current, base, expected) => {
    expect(nextForkVersion(current, base)).toBe(expected);
  });

  it.each([
    ["0.1.6-nightly.20261028.3", undefined, /expected X\.Y\.Z/],
    ["garbage", undefined, /expected X\.Y\.Z/],
    ["0.1.6-fork.1", "0.1.5", /older than/],
    ["0.1.6-fork.1", "0.1.7-fork.1", /stable X\.Y\.Z/],
    ["0.1.6-fork.1", "v0.1.7", /stable X\.Y\.Z/],
  ])("rejects %s with base %s", (current, base, message) => {
    expect(() => nextForkVersion(current, base)).toThrow(message);
  });
});

describe("parseArgs", () => {
  it.each([
    [[], { base: undefined, dryRun: false }],
    [["--dry-run"], { base: undefined, dryRun: true }],
    [["--base", "0.1.7"], { base: "0.1.7", dryRun: false }],
    [["--base=0.1.7", "--dry-run"], { base: "0.1.7", dryRun: true }],
  ])("%j", (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each([[["--bogus"]], [["--base="]], [["--base"]]])("rejects %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe("setMobileForkVersion", () => {
  it("writes the numeric base into the fork profile and nothing else", () => {
    const before = {
      build: { fork: { env: { T3CODE_MOBILE_VERSION: "0.1.6" } }, other: { a: 1 } },
    };
    const after = JSON.parse(
      setMobileForkVersion(JSON.stringify(before), "0.1.7-fork.2"),
    ) as typeof before;
    expect(after.build.fork.env.T3CODE_MOBILE_VERSION).toBe("0.1.7");
    expect(after.build.other).toEqual({ a: 1 });
  });

  it("ends with a newline", () => {
    expect(
      setMobileForkVersion(
        '{"build":{"fork":{"env":{"T3CODE_MOBILE_VERSION":"1.0.0"}}}}',
        "1.0.0-fork.1",
      ),
    ).toMatch(/\n$/);
  });
});

effectIt.layer(NodeServices.layer)("bumpForkVersion", (it) => {
  const makeRoot = Effect.fn("makeRoot")(function* (version: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-version-" });
    for (const file of releasePackageFiles) {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
      yield* fs.writeFileString(path.join(root, file), JSON.stringify({ version }));
    }
    yield* fs.makeDirectory(path.join(root, "apps/mobile"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "apps/mobile/eas.json"),
      JSON.stringify({ build: { fork: { env: { T3CODE_MOBILE_VERSION: "0.1.6" } } } }),
    );
    return root;
  });

  const readVersions = Effect.fn("readVersions")(function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifests = yield* Effect.forEach([...releasePackageFiles], (file) =>
      fs.readFileString(path.join(root, file)).pipe(Effect.map((text) => JSON.parse(text).version)),
    );
    const eas = JSON.parse(yield* fs.readFileString(path.join(root, "apps/mobile/eas.json")));
    return { manifests, mobile: eas.build.fork.env.T3CODE_MOBILE_VERSION };
  });

  it.effect("bumps every manifest and the mobile profile together", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot("0.1.6-fork.1");
      const result = yield* bumpForkVersion(root, ["--base", "0.1.7"]);
      assert.deepStrictEqual(result, {
        current: "0.1.6-fork.1",
        next: "0.1.7-fork.1",
        dryRun: false,
      });
      assert.deepStrictEqual(yield* readVersions(root), {
        manifests: releasePackageFiles.map(() => "0.1.7-fork.1"),
        mobile: "0.1.7",
      });
    }),
  );

  it.effect("writes nothing on a dry run", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot("0.1.6-fork.1");
      const result = yield* bumpForkVersion(root, ["--dry-run"]);
      assert.strictEqual(result.next, "0.1.6-fork.2");
      assert.deepStrictEqual(yield* readVersions(root), {
        manifests: releasePackageFiles.map(() => "0.1.6-fork.1"),
        mobile: "0.1.6",
      });
    }),
  );
});
