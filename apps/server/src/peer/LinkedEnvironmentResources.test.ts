import { EnvironmentId, OrchestratorMcpFailure, type PeerLink } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as LinkedEnvironmentResources from "./LinkedEnvironmentResources.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const at = (ms: number) => DateTime.makeUnsafe(ms);
const vps = EnvironmentId.make("env-vps");

const linkTo = (overrides: Partial<PeerLink> = {}): PeerLink => ({
  environmentId: vps,
  label: "VPS",
  urls: ["https://vps.example"],
  access: "full-access",
  linkedAt: at(0),
  expiresAt: at(Duration.toMillis(Duration.days(30))),
  lastReachedAt: null,
  lastError: null,
  ...overrides,
});

const HOST = {
  serverVersion: "1.0.0",
  cpu: { count: 4, utilization: 0.25 },
  memory: { totalBytes: 8e9, availableBytes: 3e9 },
  disk: null,
  threads: 5,
  running: 2,
  waiting: 1,
  subagentsRunning: 3,
  providers: [],
};
const HEAVY = {
  askUser: false,
  mac: { pressure: {}, reading: null, running: 1, maxRunning: 3 },
  running: [{ id: "a", command: "secret --token x" }],
  waiting: [{ id: "b" }, { id: "c" }],
  commands: [],
};

type Answer = (tool: string) => Effect.Effect<unknown, OrchestratorMcpFailure>;
const failure = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "The linked environment stopped answering.",
});
const answering: Answer = (tool) => Effect.succeed(tool === "t3_host" ? HOST : HEAVY);

const setup = (input: {
  readonly link?: PeerLink;
  readonly enabled?: boolean;
  readonly answer?: Answer;
}) =>
  Effect.gen(function* () {
    const answer = yield* Ref.make<Answer>(input.answer ?? answering);
    const calls = yield* Ref.make<ReadonlyArray<{ tool: string; limits: unknown; args: unknown }>>(
      [],
    );
    const links = PeerLinks.PeerLinks.of({
      enabled: Effect.succeed(input.enabled ?? true),
      stored: Effect.succeed([input.link ?? linkTo()]),
      link: () => Effect.die("unused"),
      list: Effect.die("unused"),
      get: () => Effect.die("unused"),
      unlink: () => Effect.die("unused"),
      resolve: () => Effect.die("unused"),
      recordOutcome: () => Effect.void,
      renewAll: Effect.die("unused"),
    });
    const peers = PeerMcpClient.PeerMcpClient.of({
      call: (request) =>
        Ref.update(calls, (all) => [
          ...all,
          { tool: request.tool, limits: request.limits, args: request.arguments },
        ]).pipe(
          Effect.andThen(Ref.get(answer)),
          Effect.flatMap((respond) => respond(request.tool)),
          Effect.map((value) => value as never),
        ),
    });
    const context = yield* Layer.build(
      LinkedEnvironmentResources.layer.pipe(
        Layer.provide(Layer.succeed(PeerLinks.PeerLinks, links)),
        Layer.provide(Layer.succeed(PeerMcpClient.PeerMcpClient, peers)),
      ),
    );
    const service = Context.get(context, LinkedEnvironmentResources.LinkedEnvironmentResources);
    return { service, answer, calls };
  });

it.effect("maps the peer's own host and heavy status into one reading, with read-only limits", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup({});
    yield* TestClock.adjust(Duration.seconds(5));
    expect(yield* service.read).toEqual([
      { environmentId: vps, label: "VPS", status: "checking", since: null, reading: null },
    ]);
    yield* service.refresh;
    expect(yield* service.read).toEqual([
      {
        environmentId: vps,
        label: "VPS",
        status: "online",
        since: at(5_000),
        reading: {
          readAt: at(5_000),
          cpuUtilization: 0.25,
          cpuCount: 4,
          availableMemoryBytes: 3e9,
          totalMemoryBytes: 8e9,
          threadsRunning: 2,
          threadsWaiting: 1,
          subagentsRunning: 3,
          heavy: { running: 1, slots: 3, waiting: 2 },
        },
      },
    ]);
    const made = yield* Ref.get(calls);
    expect(made.map((call) => call.tool).toSorted()).toEqual(["t3_heavy", "t3_host"]);
    for (const call of made) {
      expect(call.limits).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
      expect(call.args).toEqual({ action: "status" });
    }
    // Fresh: nothing is asked again inside the TTL.
    yield* TestClock.adjust(Duration.seconds(10));
    yield* service.refresh;
    expect((yield* Ref.get(calls)).length).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("goes offline since its last answer and keeps that reading only as the old one", () =>
  Effect.gen(function* () {
    const { service, answer } = yield* setup({});
    yield* service.refresh;
    yield* Ref.set(answer, () => Effect.fail(failure));
    yield* TestClock.adjust(Duration.seconds(20));
    yield* service.refresh;
    const [offline] = yield* service.read;
    expect(offline?.status).toBe("offline");
    expect(offline?.since).toEqual(at(0));
    expect(offline?.reading?.readAt).toEqual(at(0));
    // Still down later: the time it went quiet does not move.
    yield* TestClock.adjust(Duration.seconds(20));
    yield* service.refresh;
    expect((yield* service.read)[0]?.since).toEqual(at(0));
    // Back: online again, since now.
    yield* Ref.set(answer, answering);
    yield* TestClock.adjust(Duration.seconds(20));
    yield* service.refresh;
    const [back] = yield* service.read;
    expect(back?.status).toBe("online");
    expect(back?.since).toEqual(at(60_000));
    expect(back?.reading?.readAt).toEqual(at(60_000));
  }).pipe(Effect.scoped),
);

it.effect("never serves an online answer older than one refresh as live", () =>
  Effect.gen(function* () {
    const { service, answer } = yield* setup({});
    yield* service.refresh;
    yield* Ref.set(answer, () => Effect.never);
    yield* TestClock.adjust(Duration.seconds(40));
    const [row] = yield* service.read;
    expect(row?.status).toBe("checking");
    expect(row?.reading?.readAt).toEqual(at(0));
  }).pipe(Effect.scoped),
);

it.effect("names a never-reached link offline since its stored last answer", () =>
  Effect.gen(function* () {
    const { service } = yield* setup({
      link: linkTo({ lastReachedAt: at(1_000) }),
      answer: () => Effect.fail(failure),
    });
    yield* TestClock.adjust(Duration.seconds(5));
    yield* service.refresh;
    expect(yield* service.read).toEqual([
      { environmentId: vps, label: "VPS", status: "offline", since: at(1_000), reading: null },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("stays online without a heavy queue reading when only t3_heavy fails", () =>
  Effect.gen(function* () {
    const { service } = yield* setup({
      answer: (tool) => (tool === "t3_host" ? Effect.succeed(HOST) : Effect.fail(failure)),
    });
    yield* service.refresh;
    const [row] = yield* service.read;
    expect(row?.status).toBe("online");
    expect(row?.reading?.heavy).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect("gives up on a peer that never answers after the timeout", () =>
  Effect.gen(function* () {
    const { service } = yield* setup({ answer: () => Effect.never });
    const fiber = yield* Effect.forkChild(service.refresh);
    yield* TestClock.adjust(Duration.seconds(20));
    yield* Fiber.join(fiber);
    expect((yield* service.read)[0]?.status).toBe("offline");
  }).pipe(Effect.scoped),
);

it.effect("asks nothing of an expired link or while linked environments is off", () =>
  Effect.gen(function* () {
    const expired = yield* setup({ link: linkTo({ expiresAt: at(0) }) });
    yield* expired.service.refresh;
    expect(yield* expired.service.read).toEqual([
      { environmentId: vps, label: "VPS", status: "expired", since: at(0), reading: null },
    ]);
    expect(yield* Ref.get(expired.calls)).toEqual([]);

    const off = yield* setup({ enabled: false });
    yield* off.service.refresh;
    expect(yield* off.service.read).toEqual([]);
    expect(yield* Ref.get(off.calls)).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("answers a read at once and runs one attempt per link for concurrent refreshes", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const { service, calls } = yield* setup({
      answer: (tool) => Deferred.await(gate).pipe(Effect.andThen(answering(tool))),
    });
    const first = yield* Effect.forkChild(service.refresh);
    const second = yield* Effect.forkChild(service.refresh);
    expect((yield* service.read)[0]?.status).toBe("checking");
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect((yield* service.read)[0]?.status).toBe("online");
    expect((yield* Ref.get(calls)).filter((call) => call.tool === "t3_host").length).toBe(1);
  }).pipe(Effect.scoped),
);

it("clamps and rounds what the peer sends into the contract's ranges", () => {
  const reading = LinkedEnvironmentResources.toReading(
    {
      cpu: { count: 3.6, utilization: 1.4 },
      memory: { totalBytes: -1, availableBytes: Number.NaN },
      running: 1,
      waiting: 0,
      subagentsRunning: 0,
    },
    Option.none(),
    at(0),
  );
  expect(reading).toMatchObject({
    cpuUtilization: 1,
    cpuCount: 4,
    totalMemoryBytes: 0,
    availableMemoryBytes: 0,
    heavy: null,
  });
});
