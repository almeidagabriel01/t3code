import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "./processRunner.ts";
import { listProcessCwds, parseLsofCwds } from "./worktreeQuiet.ts";

describe("worktree quiet checks", () => {
  it("reads each process's working directory from lsof", () => {
    expect(parseLsofCwds("p12\nfcwd\nn/Users/me/code\np13\nfcwd\nn/\nnot a path\n")).toEqual([
      "/Users/me/code",
      "/",
    ]);
  });

  it.effect("finds this process's working directory", () =>
    Effect.gen(function* () {
      expect(yield* listProcessCwds()).toContain(process.cwd());
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});
