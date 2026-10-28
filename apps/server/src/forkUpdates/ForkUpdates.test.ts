import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { ForkUpdates, layer, parseMergeTreeConflicts, resolveForkPath } from "./ForkUpdates.ts";

const result = (code: number, stdout = "") => ({
  stdout,
  stderr: "",
  code,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const runnerFor = (answers: Record<string, ReturnType<typeof result>>) =>
  Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed(answers[input.args.join(" ")] ?? result(1)),
  } as never);

describe("ForkUpdates", () => {
  it("parses conflicted paths from merge-tree output", () => {
    assert.deepStrictEqual(
      parseMergeTreeConflicts(
        "abc123\na.ts\nb/c.ts\n\nCONFLICT (content): Merge conflict in a.ts\n",
      ),
      ["a.ts", "b/c.ts"],
    );
    assert.deepStrictEqual(parseMergeTreeConflicts("abc123\n"), []);
  });

  it("expands the home folder and falls back to the default", () => {
    assert.strictEqual(resolveForkPath("~/x", "/home/u"), "/home/u/x");
    assert.strictEqual(resolveForkPath("", "/home/u"), "/home/u/Documents/DEV/t3code");
  });

  it.effect("reports behind count, tags and predicted conflicts", () =>
    Effect.gen(function* () {
      const status = yield* (yield* ForkUpdates).status({ path: "/repo" });
      assert.strictEqual(status.available, true);
      assert.strictEqual(status.behind, 3);
      assert.strictEqual(status.headSha, "h1");
      assert.strictEqual(status.headTag, "v1.0.0");
      assert.strictEqual(status.upstreamTag, "v1.1.0");
      assert.strictEqual(status.wouldConflict, true);
      assert.deepStrictEqual(status.conflictFiles, ["a.ts"]);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            runnerFor({
              "remote get-url upstream": result(0, "url"),
              "rev-list --count main..upstream/main": result(0, "3\n"),
              "log -1 --format=%H%x09%s main": result(0, "h1\tsubject\n"),
              "merge-tree --write-tree --name-only main upstream/main": result(1, "t\na.ts\n\nmsg"),
              "describe --tags --abbrev=0 main": result(0, "v1.0.0\n"),
              "describe --tags --abbrev=0 upstream/main": result(0, "v1.1.0\n"),
              "rev-parse upstream/main": result(0, "u1\n"),
              "fetch upstream --tags --quiet": result(0),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("is unavailable without an upstream remote", () =>
    Effect.gen(function* () {
      const status = yield* (yield* ForkUpdates).status({ path: "/nope" });
      assert.strictEqual(status.available, false);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(runnerFor({}))))),
  );
});
