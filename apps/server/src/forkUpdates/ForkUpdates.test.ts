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
    assert.strictEqual(resolveForkPath("", "/home/u"), "/home/u/DEV/Pessoal/t3code");
  });

  const answers = {
    "remote get-url upstream": result(0, "url"),
    "fetch upstream --tags --quiet": result(0),
    "show main:apps/desktop/package.json": result(0, '{"version":"0.1.3"}'),
    "tag --list v*": result(
      0,
      "v0.1.2\nv0.1.3\nv0.1.4-nightly.20261028.3824\nv0.1.4-preview.20261027.1\n",
    ),
    "tag --list v* --merged main": result(0, "v0.1.2\nv0.1.3\n"),
    "log -1 --format=%H%x09%s main": result(0, "h1\tsubject\n"),
    "rev-list --count main..v0.1.3": result(0, "0\n"),
    "rev-parse v0.1.3^{commit}": result(0, "u1\n"),
  };

  it.effect("follows the stable channel and ignores newer nightly tags", () =>
    Effect.gen(function* () {
      const status = yield* (yield* ForkUpdates).status({ path: "/repo", channel: "auto" });
      assert.strictEqual(status.channel, "stable");
      assert.strictEqual(status.upstreamTag, "v0.1.3");
      assert.strictEqual(status.headTag, "v0.1.3");
      assert.strictEqual(status.behind, 0);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(runnerFor(answers))))),
  );

  it.effect("reports behind count and predicted conflicts against the channel tag", () =>
    Effect.gen(function* () {
      const status = yield* (yield* ForkUpdates).status({ path: "/repo", channel: "nightly" });
      assert.strictEqual(status.channel, "nightly");
      assert.strictEqual(status.upstreamTag, "v0.1.4-nightly.20261028.3824");
      assert.strictEqual(status.headTag, null);
      assert.strictEqual(status.behind, 3);
      assert.strictEqual(status.wouldConflict, true);
      assert.deepStrictEqual(status.conflictFiles, ["a.ts"]);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            runnerFor({
              ...answers,
              "rev-list --count main..v0.1.4-nightly.20261028.3824": result(0, "3\n"),
              "merge-tree --write-tree --name-only main v0.1.4-nightly.20261028.3824": result(
                1,
                "t\na.ts\n\nmsg",
              ),
              "rev-parse v0.1.4-nightly.20261028.3824^{commit}": result(0, "u2\n"),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("is unavailable without an upstream remote", () =>
    Effect.gen(function* () {
      const status = yield* (yield* ForkUpdates).status({ path: "/nope", channel: "auto" });
      assert.strictEqual(status.available, false);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(runnerFor({}))))),
  );

  const status = (
    overrides: Record<string, ReturnType<typeof result>>,
    channel: "auto" | "stable" | "nightly" = "auto",
  ) =>
    Effect.flatMap(ForkUpdates, (service) => service.status({ path: "/repo", channel })).pipe(
      Effect.provide(layer.pipe(Layer.provide(runnerFor({ ...answers, ...overrides })))),
    );

  it.effect("a failed fetch still answers from the tags already on disk", () =>
    Effect.gen(function* () {
      const reported = yield* status({ "fetch upstream --tags --quiet": result(128) });
      assert.strictEqual(reported.available, true);
      assert.strictEqual(reported.upstreamTag, "v0.1.3");
    }),
  );

  it.effect("an unreadable desktop version falls back to stable", () =>
    Effect.gen(function* () {
      for (const stdout of ["not json", "{}", '{"version":42}']) {
        const reported = yield* status({
          "show main:apps/desktop/package.json": result(0, stdout),
        });
        assert.strictEqual(reported.channel, "stable", stdout);
      }
      const missing = yield* status({ "show main:apps/desktop/package.json": result(128) });
      assert.strictEqual(missing.channel, "stable");
    }),
  );

  it.effect("a nightly desktop version follows nightly, and an explicit channel wins", () =>
    Effect.gen(function* () {
      const nightly = {
        "show main:apps/desktop/package.json": result(0, '{"version":"0.1.4-nightly.20261028.1"}'),
      };
      // Even when the rest of the inspection fails, the channel is the one followed.
      const failed = yield* status(nightly);
      assert.strictEqual(failed.available, false);
      assert.strictEqual(failed.channel, "nightly");
      const followed = yield* status({
        ...nightly,
        "rev-list --count main..v0.1.4-nightly.20261028.3824": result(0, "0\n"),
      });
      assert.strictEqual(followed.channel, "nightly");
      assert.strictEqual((yield* status(nightly, "stable")).channel, "stable");
    }),
  );

  it.effect("no tag of the channel is available with nothing to update to", () =>
    Effect.gen(function* () {
      const reported = yield* status({ "tag --list v*": result(0, "v0.1.4-nightly.20261028.1\n") });
      assert.strictEqual(reported.available, true);
      assert.strictEqual(reported.upstreamTag, null);
      assert.strictEqual(reported.behind, 0);
      assert.strictEqual(reported.wouldConflict, null);
      const none = yield* status({ "tag --list v*": result(1) });
      assert.strictEqual(none.upstreamTag, null);
    }),
  );

  it.effect("an unknown conflict check or a clean one is not reported as a conflict", () =>
    Effect.gen(function* () {
      const behind = { "rev-list --count main..v0.1.3": result(0, "2\n") };
      const clean = yield* status({
        ...behind,
        "merge-tree --write-tree --name-only main v0.1.3": result(0, "tree\n"),
      });
      assert.strictEqual(clean.wouldConflict, false);
      assert.deepStrictEqual(clean.conflictFiles, []);
      const failed = yield* status({
        ...behind,
        "merge-tree --write-tree --name-only main v0.1.3": result(129),
      });
      assert.strictEqual(failed.behind, 2);
      assert.strictEqual(failed.wouldConflict, null);
      const unreadable = yield* status({ "rev-list --count main..v0.1.3": result(0, "x\n") });
      assert.strictEqual(unreadable.behind, 0);
      assert.strictEqual(
        (yield* status({ "log -1 --format=%H%x09%s main": result(128) })).available,
        false,
      );
    }),
  );

  it("expands only a leading home reference", () => {
    assert.strictEqual(resolveForkPath("~", "/home/u"), "/home/u");
    assert.strictEqual(resolveForkPath("  ~/a b  ", "/home/u"), "/home/u/a b");
    assert.strictEqual(resolveForkPath("/x/~/y", "/home/u"), "/x/~/y");
    assert.strictEqual(resolveForkPath("   ", "/home/u"), "/home/u/DEV/Pessoal/t3code");
  });
});
