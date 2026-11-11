import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProcessOwners, registerOwner } from "@t3tools/shared/ProcessOwners";

import * as ProcessOwnersLive from "../process/processOwners.ts";
import { liveOwners } from "./Owners.ts";

const proc = (pid: number) => ({ identity: { pid, startTimeMs: 1 } });

describe("liveOwners", () => {
  it.each([
    ["keeps owners whose process is alive", [{ kind: "agent", pid: 2, threadId: "t" }], [2], 1],
    ["drops owners whose process is gone", [{ kind: "device-hub", pid: 9 }], [2], 0],
    [
      "keeps the newest registration for a reused pid",
      [
        { kind: "agent", pid: 2, threadId: "old" },
        { kind: "agent", pid: 2, threadId: "new" },
      ],
      [2],
      1,
    ],
    [
      "keeps terminal owners off the wire",
      [{ kind: "terminal", pid: 2, threadId: "t", terminalId: "default" }],
      [2],
      0,
    ],
    ["returns nothing without processes", [{ kind: "agent", pid: 2, threadId: "t" }], [], 0],
  ] as const)("%s", (_name, registered, pids, expected) => {
    const owners = liveOwners(registered, pids.map(proc));
    expect(owners).toHaveLength(expected);
    if (_name.includes("newest")) expect(owners[0]).toMatchObject({ threadId: "new" });
  });
});

describe("process owners registry", () => {
  it.effect("keeps a pid until it was seen and then vanished, or never showed up", () =>
    Effect.gen(function* () {
      const owners = yield* ProcessOwners;
      yield* owners.register({ kind: "agent", pid: 2, threadId: "a" });
      yield* owners.register({ kind: "device-hub", pid: 3 });
      yield* owners.retain(new Set([3]));
      // pid 2 predates its first sample: kept. pid 3 is now seen.
      expect(yield* owners.list).toHaveLength(2);
      yield* owners.retain(new Set([2]));
      expect(yield* owners.list).toEqual([{ kind: "agent", pid: 2, threadId: "a" }]);
      yield* owners.retain(new Set());
      expect(yield* owners.list).toEqual([]);
    }).pipe(Effect.provide(ProcessOwnersLive.layer)),
  );

  it.effect("gives up on a pid that never appears", () =>
    Effect.gen(function* () {
      const owners = yield* ProcessOwners;
      yield* owners.register({ kind: "device-hub", pid: 5 });
      for (let sample = 0; sample < ProcessOwnersLive.UNSEEN_SAMPLE_GRACE; sample++) {
        yield* owners.retain(new Set());
      }
      expect(yield* owners.list).toEqual([]);
    }).pipe(Effect.provide(ProcessOwnersLive.layer)),
  );
});

describe("registerOwner", () => {
  it.effect("registers a real pid and ignores a missing one", () =>
    Effect.gen(function* () {
      const owners = yield* ProcessOwners;
      yield* registerOwner({ kind: "agent", pid: Number.NaN, threadId: "a" });
      yield* registerOwner({ kind: "agent", pid: 0, threadId: "a" });
      yield* registerOwner({ kind: "device-hub", pid: 7 });
      expect(yield* owners.list).toEqual([{ kind: "device-hub", pid: 7 }]);
    }).pipe(Effect.provide(ProcessOwnersLive.layer)),
  );

  it.effect("does nothing without a live registry", () =>
    registerOwner({ kind: "device-hub", pid: 7 }),
  );

  it.effect("the default registry holds nothing", () =>
    Effect.gen(function* () {
      const owners = yield* ProcessOwners;
      yield* owners.register({ kind: "device-hub", pid: 1 });
      yield* owners.retain(new Set());
      expect(yield* owners.list).toEqual([]);
    }),
  );
});
