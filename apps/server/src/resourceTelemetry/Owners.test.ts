import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ResourceTelemetryConsumer,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ProcessOwners, registerOwner } from "@t3tools/shared/ProcessOwners";

import * as ProcessOwnersLive from "../process/processOwners.ts";
import { consumerOf, liveOwners, withConsumers } from "./Owners.ts";

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

const environmentId = EnvironmentId.make("mac");
const providerInstanceId = ProviderInstanceId.make("codex");
const lineage = (id: string, parent?: string, relationshipToParent?: "fork" | "subagent") => ({
  parentThreadId: parent === undefined ? null : ThreadId.make(parent),
  relationshipToParent: relationshipToParent ?? null,
  rootThreadId: ThreadId.make(parent ?? id),
});

describe("consumerOf", () => {
  const delegatedFrom = {
    environmentId: EnvironmentId.make("vps"),
    threadId: ThreadId.make("remote-parent"),
    title: "Parent",
  };
  it.each([
    ["a plain thread", "t1", lineage("t1"), null, null, { kind: "thread" }],
    [
      "a fork reads as its own thread",
      "t2",
      lineage("t2", "t1", "fork"),
      null,
      null,
      { kind: "thread" },
    ],
    [
      "a subagent",
      "t3",
      lineage("t3", "t1", "subagent"),
      null,
      null,
      { kind: "subagent", parentThreadId: "t1" },
    ],
    [
      "a task delegated from a linked environment",
      "t4",
      lineage("t4"),
      delegatedFrom,
      null,
      { kind: "subagent", parentThreadId: "remote-parent" },
    ],
    [
      "an assistant",
      "assistant:ana:2",
      lineage("assistant:ana:2"),
      null,
      null,
      { kind: "assistant", assistantId: "ana" },
    ],
    [
      "a group member",
      "assistant:ana:g-0123456789abcdef",
      lineage("assistant:ana:g-0123456789abcdef"),
      null,
      "team:1",
      { kind: "groupMember", assistantId: "ana", groupId: "team:1" },
    ],
    [
      "a group member whose group row is missing",
      "assistant:ana:g-0123456789abcdef",
      lineage("assistant:ana:g-0123456789abcdef"),
      null,
      null,
      { kind: "groupMember", assistantId: "ana" },
    ],
  ] as const)("%s", (_name, id, threadLineage, delegated, groupId, expected) => {
    expect(
      consumerOf({
        thread: {
          id: ThreadId.make(id),
          providerInstanceId,
          lineage: threadLineage,
          ...(delegated === null ? {} : { delegatedFrom: delegated }),
        },
        groupId,
        environmentId,
      }),
    ).toEqual({ threadId: id, environmentId, providerInstanceId, ...expected });
  });
});

describe("withConsumers", () => {
  const consumer = (threadId: string): ResourceTelemetryConsumer => ({
    kind: "thread",
    threadId: ThreadId.make(threadId),
    environmentId,
    providerInstanceId,
  });

  it.effect("tags agents, keeps the rest, and looks each live process up once", () =>
    Effect.gen(function* () {
      const cache = new Map<string, ResourceTelemetryConsumer>();
      const lookups: string[] = [];
      const resolve = (threadId: ThreadId) =>
        Effect.sync(() => {
          lookups.push(threadId);
          if (threadId === "gone") return null;
          return consumer(threadId);
        });
      const owners = [
        { kind: "agent", pid: 2, threadId: "a" },
        { kind: "agent", pid: 3, threadId: "gone" },
        { kind: "device-hub", pid: 4 },
      ] as const;
      expect(yield* withConsumers(owners, cache, resolve)).toEqual([
        { kind: "agent", pid: 2, threadId: "a", consumer: consumer("a") },
        { kind: "agent", pid: 3, threadId: "gone" },
        { kind: "device-hub", pid: 4 },
      ]);
      yield* withConsumers(owners, cache, resolve);
      // A known process is cached; an unreadable thread is asked again.
      expect(lookups).toEqual(["a", "gone", "gone"]);
      yield* withConsumers([{ kind: "agent", pid: 5, threadId: "b" }], cache, resolve);
      expect([...cache.keys()]).toEqual(["5:b"]);
    }),
  );

  it.effect("a failed lookup leaves the owner untagged", () =>
    Effect.gen(function* () {
      const owners = yield* withConsumers(
        [{ kind: "agent", pid: 2, threadId: "a" }],
        new Map(),
        () => Effect.fail("read failed"),
      );
      expect(owners).toEqual([{ kind: "agent", pid: 2, threadId: "a" }]);
    }),
  );
});
