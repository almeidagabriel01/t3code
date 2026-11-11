import { describe, expect, it } from "@effect/vitest";
import {
  type Decision,
  DecisionId,
  type DecisionsEvent,
  type DeviceAccessMap,
  DeviceId,
  type DeviceHostId,
  LOCAL_DEVICE_HOST_ID,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as DecisionService from "../decisions/DecisionService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { askDeviceAccess } from "./DeviceAccessApproval.ts";
import type * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";

const simulator = {
  id: "SIM-1",
  name: "iPhone 17",
  version: "iOS 27.0",
  platform: "ios" as const,
  booted: true,
  physical: false,
};
const phone = {
  id: "PIXEL-1",
  name: "Pixel 9",
  version: "Android 16",
  platform: "android" as const,
  booted: true,
  physical: true,
};
const lockedPhone = { ...phone, id: "PIXEL-OFF", name: "Pixel 8", booted: false };

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const on = (deviceId: string, threadId = threadA) => ({
  threadId,
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId: DeviceId.make(deviceId),
});

const harness = Effect.fn("harness")(function* () {
  const calls = {
    boots: [] as Array<string>,
    shutdowns: [] as Array<string>,
    markers: [] as Array<readonly [string, string | null]>,
    cleared: 0,
  };
  const run = () => Effect.succeed({ code: 0, stdout: "", stderr: "" });
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    devices: {
      list: Effect.succeed({ devices: [simulator, phone, lockedPhone], detail: undefined }),
      boot: (device) =>
        Effect.sync(() => {
          calls.boots.push(device.id);
          return device.id;
        }),
      attach: () => Effect.void,
      shutdown: (device) => Effect.sync(() => void calls.shutdowns.push(device.id)),
      screenshot: () => Effect.succeed(new Uint8Array()),
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run,
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    id: LOCAL_DEVICE_HOST_ID,
    label: "This machine",
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "This machine",
      platforms: [
        { platform: "ios", available: true },
        { platform: "android", available: true },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () =>
      Effect.succeed({
        ...ready,
        agentDevice: { baseUrl: "http://agent.test", token: "test", entryPath: "/agent" },
      }),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
  const hosts = new Map<DeviceHostId, DeviceHost.DeviceHost["Service"]>([[host.id, host]]);
  const service = yield* DeviceService.makeWithHosts(
    hosts,
    undefined,
    () => Effect.succeed("/host.json"),
    undefined,
    {
      bind: ({ session }) => Effect.succeed(session),
      prune: () => Effect.void,
      release: () => Effect.void,
      hold: (device, message) =>
        Effect.sync(() => void calls.markers.push([device.deviceId, message])),
      clearHolds: Effect.sync(() => void calls.cleared++),
    },
  ).pipe(Effect.provide(NodeCrypto.layer));
  yield* service.list;
  return { service, calls, hosts };
});

const withSettings = (deviceAccess: DeviceAccessMap = {}) =>
  Effect.provide(
    ServerSettings.layerTest({
      enableDeviceSupport: true,
      enableAgentDeviceAccess: true,
      deviceAccess,
    }),
  );

describe("takeover", () => {
  it.effect(
    "is set by an action or by input, repeats change nothing, and only a hand back ends it",
    () =>
      Effect.gen(function* () {
        const { service, calls, hosts } = yield* harness();
        // A marker a previous run left would block agents with nothing to hand back.
        expect(calls.cleared).toBe(1);
        const sim = { deviceId: DeviceId.make(simulator.id) };

        const taken = yield* service.setHold({ ...sim, held: true });
        expect(taken.holds).toMatchObject([
          { hostId: LOCAL_DEVICE_HOST_ID, deviceId: simulator.id },
        ]);
        expect(taken.supportsDeviceControl).toBe(true);
        expect(calls.markers).toHaveLength(1);
        expect(calls.markers[0]?.[1]).toContain("The user is holding this device: iPhone 17");

        // Neither a second take nor more input publishes: touch frames arrive constantly.
        expect((yield* service.setHold({ ...sim, held: true })).revision).toBe(taken.revision);
        yield* service.holdOnInput(undefined, sim.deviceId);
        expect((yield* service.state).revision).toBe(taken.revision);

        // Nothing but a hand back ends it: not a refresh, an open, a close, or the host list changing.
        yield* service.list;
        yield* service.open({ ...on(simulator.id), platform: "ios" });
        yield* service.close(on(simulator.id));
        yield* service.refreshHosts;
        expect((yield* service.state).holds).toEqual(taken.holds);

        const handedBack = yield* service.setHold({ ...sim, held: false });
        expect(handedBack.holds).toEqual([]);
        expect(calls.markers.at(-1)).toEqual([simulator.id, null]);
        expect((yield* service.setHold({ ...sim, held: false })).revision).toBe(
          handedBack.revision,
        );

        // Input through the stream takes the device over; input for an unlisted device is ignored.
        yield* service.holdOnInput(LOCAL_DEVICE_HOST_ID, DeviceId.make(phone.id));
        yield* service.holdOnInput(undefined, DeviceId.make("not-listed"));
        expect((yield* service.state).holds).toMatchObject([{ deviceId: phone.id }]);
        expect(
          yield* Effect.flip(
            service.setHold({ deviceId: DeviceId.make("not-listed"), held: true }),
          ),
        ).toMatchObject({ _tag: "DeviceNotFoundError" });

        // A removed host takes its holds with it.
        hosts.clear();
        yield* service.refreshHosts;
        expect((yield* service.state).holds).toEqual([]);
        expect(calls.markers.at(-1)).toEqual([phone.id, null]);
      }).pipe(withSettings(), Effect.scoped),
  );
});

describe("agent access", () => {
  const stored = {
    [`local:${simulator.id}`]: "deny",
    [`local:${lockedPhone.id}`]: "allow",
    // A value this build cannot read falls back to the device's default.
    "local:unreadable": { future: true },
  };
  it.effect.each([
    { device: simulator.id, intent: "open", held: false, expected: "allowed" },
    { device: phone.id, intent: "open", held: false, expected: "DeviceAccessPendingError" },
    { device: phone.id, intent: "read", held: false, expected: "DeviceAccessPendingError" },
    // Ending a session is never using the device.
    { device: phone.id, intent: "close", held: false, expected: "allowed" },
    { device: simulator.id, intent: "open", held: true, expected: "DeviceHeldError" },
    { device: simulator.id, intent: "close", held: true, expected: "DeviceHeldError" },
    { device: simulator.id, intent: "read", held: true, expected: "allowed" },
  ] as const)(
    "by default $intent on $device (held: $held) is $expected",
    ({ device, intent, held, expected }) =>
      Effect.gen(function* () {
        const { service } = yield* harness();
        if (held) yield* service.setHold({ deviceId: DeviceId.make(device), held: true });
        const result = yield* service.authorizeAgent({ ...on(device), intent }).pipe(
          Effect.as("allowed"),
          Effect.catch((error) => Effect.succeed(error._tag)),
        );
        expect(result).toBe(expected);
      }).pipe(withSettings(), Effect.scoped),
  );

  it.effect.each([
    { device: simulator.id, intent: "open", expected: "DeviceAccessDeniedError" },
    { device: simulator.id, intent: "read", expected: "DeviceAccessDeniedError" },
    { device: simulator.id, intent: "close", expected: "allowed" },
    { device: lockedPhone.id, intent: "open", expected: "allowed" },
    { device: "unreadable", intent: "open", expected: "allowed" },
  ] as const)("with a stored policy $intent on $device is $expected", (row) =>
    Effect.gen(function* () {
      const { service } = yield* harness();
      const result = yield* service.authorizeAgent({ ...on(row.device), intent: row.intent }).pipe(
        Effect.as("allowed"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
      expect(result).toBe(row.expected);
    }).pipe(withSettings(stored), Effect.scoped),
  );

  it.effect("asks once per thread and remembers each thread's answer", () =>
    Effect.gen(function* () {
      const { service } = yield* harness();
      const asked: Array<string> = [];
      const agent = (answer: DeviceService.DeviceAccessAnswer) => ({
        ask: (question: DeviceService.DeviceAccessQuestion) =>
          Effect.sync(() => {
            asked.push(`${question.threadId}:${question.deviceName}@${question.hostLabel}`);
            return answer;
          }),
      });
      const open = (threadId: ThreadId, answer: DeviceService.DeviceAccessAnswer) =>
        service
          .authorizeAgent({ ...on(phone.id, threadId), intent: "open", agent: agent(answer) })
          .pipe(
            Effect.as("allowed"),
            Effect.catch((error) => Effect.succeed(error.message)),
          );

      // An unanswered question is asked again; an answer is not.
      expect(yield* open(threadA, "pending")).toContain("Still waiting for the user");
      expect(yield* open(threadA, "allowed")).toBe("allowed");
      expect(yield* open(threadA, "declined")).toBe("allowed");
      expect(yield* open(threadB, "declined")).toContain(
        "The user did not allow this thread to use Pixel 9",
      );
      expect(yield* open(threadB, "allowed")).toContain("did not allow");
      expect(asked).toEqual([
        "thread-a:Pixel 9@This machine",
        "thread-a:Pixel 9@This machine",
        "thread-b:Pixel 9@This machine",
      ]);
    }).pipe(withSettings(), Effect.scoped),
  );

  it.effect("refuses a denied device before it boots and at every later step", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness();
      const denied = { _tag: "DeviceAccessDeniedError", reason: "policy" };
      expect(
        yield* Effect.flip(service.open({ ...on(simulator.id), platform: "ios" }, { agent: {} })),
      ).toMatchObject(denied);
      expect((yield* service.state).sessions).toEqual([]);
      // The user's own client is not an agent: it opens the device.
      yield* service.open({ ...on(simulator.id), platform: "ios" });
      expect(yield* Effect.flip(service.agentTarget(on(simulator.id)))).toMatchObject(denied);
      expect(
        yield* Effect.flip(service.agentLauncher({ ...on(simulator.id), targetArgs: [] })),
      ).toMatchObject(denied);
      expect(calls.boots).toEqual([]);
    }).pipe(withSettings({ [`local:${simulator.id}`]: "deny" }), Effect.scoped),
  );

  it.effect("names the thread whose agent already drives the device", () =>
    Effect.gen(function* () {
      const { service } = yield* harness();
      yield* service.open({ ...on(simulator.id), platform: "ios" });
      const target = yield* service.agentTarget(on(simulator.id));
      yield* service.agentLauncher({
        ...on(simulator.id),
        targetArgs: target.args,
        agent: { threadTitle: "Fix login" },
      });
      // The owning thread can open it again; another thread is told who has it.
      yield* service.authorizeAgent({ ...on(simulator.id), intent: "open" });
      const inUse = yield* Effect.flip(
        service.authorizeAgent({ ...on(simulator.id, threadB), intent: "open" }),
      );
      expect(inUse).toMatchObject({ _tag: "DeviceInUseError", threadId: threadA });
      expect(inUse.message).toBe(
        'iPhone 17 is in use by the agent in the thread "Fix login" (thread-a). Use another device, or wait until that thread closes it. Do not close or reuse that thread\'s session.',
      );
      // Looking is not driving.
      yield* service.authorizeAgent({ ...on(simulator.id, threadB), intent: "read" });
      yield* service.close(on(simulator.id));
      yield* service.authorizeAgent({ ...on(simulator.id, threadB), intent: "open" });
    }).pipe(withSettings(), Effect.scoped),
  );

  it.effect("stores a policy beside entries it cannot read and resets one to its default", () =>
    Effect.gen(function* () {
      const { service } = yield* harness();
      const settings = yield* ServerSettings.ServerSettingsService;
      const future = { "ssh-1:other": "allow", "local:unreadable": { future: true } };
      const set = yield* service.setAccess({ deviceId: DeviceId.make(phone.id), policy: "deny" });
      expect(set.access).toEqual({ ...future, [`local:${phone.id}`]: "deny" });
      expect((yield* settings.getSettings).deviceAccess).toEqual(set.access);
      expect(
        yield* Effect.flip(service.authorizeAgent({ ...on(phone.id), intent: "open" })),
      ).toMatchObject({ _tag: "DeviceAccessDeniedError" });

      const reset = yield* service.setAccess({ deviceId: DeviceId.make(phone.id), policy: null });
      expect(reset.access).toEqual(future);
      expect((yield* settings.getSettings).deviceAccess).toEqual(future);
    }).pipe(
      withSettings({ "ssh-1:other": "allow", "local:unreadable": { future: true } }),
      Effect.scoped,
    ),
  );
});

describe("physical devices", () => {
  it.effect("are never booted or shut down", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness();
      const unavailable = (operation: string) => ({
        _tag: "DeviceActionUnavailableError",
        operation,
        reason: "physical_device",
      });
      expect(
        yield* Effect.flip(service.open({ ...on(lockedPhone.id), platform: "android" })),
      ).toMatchObject(unavailable("boot"));

      yield* service.open({ ...on(phone.id), platform: "android" });
      yield* service.open({ ...on(phone.id, threadB), platform: "android" });
      expect(
        yield* Effect.flip(
          service.shutdown({ deviceId: DeviceId.make(phone.id), platform: "android" }),
        ),
      ).toMatchObject(unavailable("shutdown"));
      expect((yield* service.state).sessions).toHaveLength(2);

      // Closing with shutdown ends only this thread's session: there is no power-off to share.
      yield* service.close({ ...on(phone.id), shutdown: true });
      expect((yield* service.state).sessions).toMatchObject([{ threadId: threadB }]);
      expect([calls.boots, calls.shutdowns]).toEqual([[], []]);
    }).pipe(withSettings(), Effect.scoped),
  );
});

describe("asking the user for device access", () => {
  const decision = (id: string, status: Decision["status"], optionId?: string): Decision => ({
    id: DecisionId.make(id),
    fromThreadId: threadA,
    threadTitle: "Fix login",
    title: "Let the agent use Pixel 9?",
    context: "",
    options: [{ id: "allow", label: "Allow" }],
    status,
    ...(optionId === undefined ? {} : { answer: { optionId } }),
    createdAt: "2026-11-10T10:00:00.000Z",
  });
  const question = {
    ...on(phone.id),
    deviceName: "Pixel 9",
    hostLabel: "This machine",
  };
  const asking = Effect.fn("asking")(function* (stored: Record<string, Decision>) {
    const events = yield* PubSub.unbounded<DecisionsEvent>();
    // Signals each subscription, so a test publishes only once the waiter listens.
    const listening = yield* Queue.unbounded<void>();
    const requested: Array<string> = [];
    const ask = askDeviceAccess(
      {
        request: (input: DecisionService.DecisionRequestInput) =>
          Effect.sync(() => {
            requested.push(input.clientRequestId);
            return (stored[input.clientRequestId] ??= decision(input.clientRequestId, "open"));
          }),
        subscribe: Stream.unwrap(
          PubSub.subscribe(events).pipe(
            Effect.tap(() => Queue.offer(listening, undefined)),
            Effect.map((subscription) => Stream.fromSubscription(subscription)),
          ),
        ),
      },
      { projectId: ProjectId.make("project-1"), threadTitle: "Fix login" },
    );
    return { ask: ask(question), events, listening, requested };
  });
  const id = `device-access:local:${phone.id}`;

  it.effect.each([
    { stored: decision(id, "answered", "allow"), expected: "allowed" },
    { stored: decision(id, "answered", "deny"), expected: "declined" },
    // Free text without an option is not a yes.
    { stored: decision(id, "answered"), expected: "declined" },
  ] as const)("an answered decision ($stored.answer.optionId) is $expected", (row) =>
    Effect.gen(function* () {
      const { ask, requested } = yield* asking({ [id]: row.stored });
      expect(yield* ask).toBe(row.expected);
      // The request id comes from the device, so a repeat lands on the same decision.
      expect(requested).toEqual([id]);
    }),
  );

  it.effect("waits for the answer and reports an unanswered question as pending", () =>
    Effect.gen(function* () {
      const { ask, events, listening } = yield* asking({});
      const answered = yield* Effect.forkChild(ask);
      yield* Queue.take(listening);
      yield* PubSub.publish(events, { type: "snapshot", decisions: [decision(id, "open")] });
      yield* PubSub.publish(events, {
        type: "upserted",
        decision: decision("another", "answered", "allow"),
      });
      yield* PubSub.publish(events, {
        type: "upserted",
        decision: decision(id, "answered", "allow"),
      });
      expect(yield* Fiber.join(answered)).toBe("allowed");

      const unanswered = yield* Effect.forkChild(ask);
      yield* Queue.take(listening);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Fiber.join(unanswered)).toBe("pending");
    }),
  );

  it.effect("asks again after a dismissed question instead of locking the thread out", () =>
    Effect.gen(function* () {
      const { ask, requested } = yield* asking({
        [id]: decision(id, "withdrawn"),
        [`${id}:1`]: decision(`${id}:1`, "expired"),
        [`${id}:2`]: decision(`${id}:2`, "answered", "allow"),
      });
      expect(yield* ask).toBe("allowed");
      expect(requested).toEqual([id, `${id}:1`, `${id}:2`]);
    }),
  );
});
