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
// A booted emulator's id is its serial; the AVD name is what it keeps.
const emulator = {
  id: "emulator-5554",
  name: "Pixel_9_API_36",
  version: "Android 16",
  platform: "android" as const,
  booted: true,
  physical: false,
};
const wifiPhone = {
  ...phone,
  id: "192.168.1.20:41233",
  name: "Pixel 7",
  connection: "wifi" as const,
  identity: "R5CT900",
};

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const on = (deviceId: string, threadId = threadA) => ({
  threadId,
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId: DeviceId.make(deviceId),
});

const harness = Effect.fn("harness")(function* (
  run: DeviceHost.DeviceHostReady["run"] = () =>
    Effect.succeed({ code: 0, stdout: "", stderr: "" }),
) {
  const calls = {
    boots: [] as Array<string>,
    shutdowns: [] as Array<string>,
    markers: [] as Array<readonly [string, string | null]>,
    cleared: 0,
    endedSessions: [] as Array<string>,
    releasedLaunchers: [] as Array<string>,
  };
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    releaseAgentSession: (session) => Effect.sync(() => void calls.endedSessions.push(session)),
    devices: {
      list: Effect.succeed({
        devices: [simulator, phone, lockedPhone, emulator, wifiPhone],
        detail: undefined,
      }),
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
      release: (launcher) => Effect.sync(() => void calls.releasedLaunchers.push(launcher)),
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

  // root delegated to child and sibling; child delegated to grandchild; other is someone else's work.
  const root = ThreadId.make("root");
  const child = ThreadId.make("child");
  const grandchild = ThreadId.make("grandchild");
  const sibling = ThreadId.make("sibling");
  const other = ThreadId.make("other");
  const ancestors: Record<string, ReadonlyArray<ThreadId>> = {
    root: [],
    child: [root],
    grandchild: [child, root],
    sibling: [root],
    other: [],
  };
  const drive = Effect.fn("drive")(function* (
    service: DeviceService.DeviceService["Service"],
    threadId: ThreadId,
  ) {
    const agent = { threadTitle: threadId, ancestors: ancestors[threadId] };
    const target = on(simulator.id, threadId);
    yield* service.open({ ...target, platform: "ios" }, { agent });
    const { session, args } = yield* service.agentTarget({ ...target, agent });
    yield* service.agentLauncher({ ...target, targetArgs: args, agent });
    return session;
  });

  it.effect.each([
    { holders: [root], opener: child, expected: "shared" },
    { holders: [root], opener: grandchild, expected: "shared" },
    { holders: [child], opener: root, expected: "shared" },
    { holders: [grandchild], opener: root, expected: "shared" },
    { holders: [child], opener: grandchild, expected: "shared" },
    { holders: [child], opener: sibling, expected: "in use by child" },
    { holders: [grandchild], opener: sibling, expected: "in use by grandchild" },
    { holders: [root], opener: other, expected: "in use by root" },
    { holders: [other], opener: child, expected: "in use by other" },
    // The parent holding it too does not let a sibling in beside the child.
    { holders: [child, root], opener: sibling, expected: "in use by child" },
  ])("a device driven by $holders is $expected for $opener", ({ holders, opener, expected }) =>
    Effect.gen(function* () {
      const { service } = yield* harness();
      const sessions = yield* Effect.forEach(holders, (holder) => drive(service, holder));
      const result = yield* drive(service, opener).pipe(
        Effect.map((session) => (sessions.every((held) => held === session) ? "shared" : "apart")),
        Effect.catchTags({
          DeviceInUseError: (error) => Effect.succeed(`in use by ${error.threadId}`),
        }),
      );
      expect(result).toBe(expected);
    }).pipe(withSettings(), Effect.scoped),
  );

  it.effect("ends a lineage's agent-device session only when its last thread closes", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness();
      const session = yield* drive(service, root);
      yield* drive(service, child);

      // device_close carries no caller; the lineage is the one the thread's open gave.
      yield* service.authorizeAgent({ ...on(simulator.id, child), intent: "close" });
      yield* service.close({ ...on(simulator.id, child), shutdown: false });
      expect(calls.endedSessions).toEqual([]);
      expect(calls.releasedLaunchers).toEqual([]);
      // The parent drives on, and other work is still told who has the device.
      yield* service.authorizeAgent({ ...on(simulator.id, root), intent: "open" });
      expect(yield* Effect.flip(drive(service, other))).toMatchObject({ threadId: root });

      yield* service.close(on(simulator.id, root));
      expect(calls.endedSessions).toEqual([session]);
      expect(yield* drive(service, other)).not.toBe(session);
    }).pipe(withSettings(), Effect.scoped),
  );

  it.effect("shares one answer across a delegation tree and asks other work again", () =>
    Effect.gen(function* () {
      const { service } = yield* harness();
      const asked: Array<string> = [];
      const open = (threadId: ThreadId, answer: DeviceService.DeviceAccessAnswer) =>
        service
          .authorizeAgent({
            ...on(phone.id, threadId),
            intent: "open",
            agent: {
              ancestors: ancestors[threadId],
              ask: () =>
                Effect.sync(() => {
                  asked.push(threadId);
                  return answer;
                }),
            },
          })
          .pipe(
            Effect.as("allowed"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
      expect(yield* open(child, "allowed")).toBe("allowed");
      expect(yield* open(root, "declined")).toBe("allowed");
      expect(yield* open(grandchild, "declined")).toBe("allowed");
      expect(yield* open(sibling, "declined")).toBe("allowed");
      expect(yield* open(other, "declined")).toBe("DeviceAccessDeniedError");
      expect(asked).toEqual([child, other]);
    }).pipe(withSettings(), Effect.scoped),
  );

  it.effect.each([
    // Stored while the emulator was off, when its id was the AVD name.
    { stored: `local:${emulator.name}`, device: emulator.id, stable: `local:${emulator.name}` },
    // Stored by a build that keyed a booted emulator by its serial.
    { stored: `local:${emulator.id}`, device: emulator.id, stable: `local:${emulator.name}` },
    { stored: `local:${wifiPhone.identity}`, device: wifiPhone.id, stable: "local:R5CT900" },
    { stored: `local:${wifiPhone.id}`, device: wifiPhone.id, stable: "local:R5CT900" },
    { stored: `local:${phone.id}`, device: phone.id, stable: `local:${phone.id}` },
    { stored: `local:${simulator.id}`, device: simulator.id, stable: `local:${simulator.id}` },
  ])("a policy stored as $stored applies to $device and moves to its stable key", (row) =>
    Effect.gen(function* () {
      const { service } = yield* harness();
      expect(
        yield* Effect.flip(service.authorizeAgent({ ...on(row.device), intent: "open" })),
      ).toMatchObject({ _tag: "DeviceAccessDeniedError", reason: "policy" });
      const set = yield* service.setAccess({
        deviceId: DeviceId.make(row.device),
        policy: "allow",
      });
      expect(set.access).toEqual({ [row.stable]: "allow" });
      yield* service.authorizeAgent({ ...on(row.device), intent: "open" });
    }).pipe(withSettings({ [row.stored]: "deny" }), Effect.scoped),
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

describe("Wi-Fi pairing and forgetting", () => {
  const PASSWORD = /P:([A-Z2-9]+);;$/;
  // A phone that has not scanned yet: adb works and sees no pairing service.
  const adbWaiting =
    (
      commands: Array<ReadonlyArray<string>>,
      answer: (args: ReadonlyArray<string>) => string = () => "",
    ): DeviceHost.DeviceHostReady["run"] =>
    (_command, args) =>
      Effect.sync(() => {
        commands.push(args);
        const stdout =
          args.join(" ") === "mdns check" ? "mdns daemon version [test]" : answer(args);
        return { code: 0, stdout, stderr: "" };
      });

  it.effect("runs one attempt per environment, repeats by request id, and cancels", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      const { service } = yield* harness(adbWaiting(commands));
      const started = yield* service.startWifiPairing({ requestId: "web-1" });
      expect(started.qrPayload).toMatch(/^WIFI:T:ADB;S:ADB_WIFI_[A-Z2-9]+;P:[A-Z2-9]+;;$/);
      expect(started.state.supportsWifiPairing).toBe(true);
      expect(started.state.wifiPairing).toEqual({
        attemptId: started.attemptId,
        hostId: LOCAL_DEVICE_HOST_ID,
        status: "waiting",
      });
      // Every client sees the attempt; only the one that started it gets the password.
      const password = PASSWORD.exec(started.qrPayload)?.[1] ?? "";
      expect(JSON.stringify(yield* service.state)).not.toContain(password);

      const repeated = yield* service.startWifiPairing({ requestId: "web-1" });
      expect(repeated.qrPayload).toBe(started.qrPayload);
      expect(yield* Effect.flip(service.startWifiPairing({ requestId: "mobile-1" }))).toMatchObject(
        { _tag: "DeviceWifiPairingBusyError", attemptId: started.attemptId },
      );

      // An unknown attempt changes nothing; the right one clears the state and frees the slot.
      const before = (yield* service.state).revision;
      expect((yield* service.cancelWifiPairing({ attemptId: "other" })).revision).toBe(before);
      expect((yield* service.cancelWifiPairing({ attemptId: started.attemptId })).wifiPairing).toBe(
        undefined,
      );
      const next = yield* service.startWifiPairing({ requestId: "mobile-1" });
      expect(next.attemptId).not.toBe(started.attemptId);
      expect(commands.some((args) => args.join(" ").includes(password))).toBe(false);
    }).pipe(withSettings(), Effect.scoped),
  );

  it.effect("publishes each step to every client and frees the slot once connected", () =>
    Effect.gen(function* () {
      let serviceName = "";
      const commands: Array<ReadonlyArray<string>> = [];
      const { service } = yield* harness(
        adbWaiting(commands, (args) =>
          args[0] === "mdns"
            ? `${serviceName}\t_adb-tls-pairing._tcp\t192.168.1.20:37111`
            : args[0] === "pair"
              ? "Successfully paired to 192.168.1.20:37111 [guid=adb-R5CT900-x]"
              : args[0] === "devices"
                ? "192.168.1.20:41233\tdevice"
                : "",
        ),
      );
      const subscription = yield* service.subscribe;
      const started = yield* service.startWifiPairing({ requestId: "web-1" });
      serviceName = started.attemptId;
      const seen: Array<string> = [];
      let last = started.state;
      while (seen.at(-1) !== "connected") {
        last = yield* PubSub.take(subscription);
        const status = last.wifiPairing?.status;
        if (status && status !== seen.at(-1)) seen.push(status);
      }
      expect(seen).toEqual(["waiting", "pairing", "connecting", "connected"]);
      expect(last.wifiPairing).toMatchObject({
        status: "connected",
        deviceId: "192.168.1.20:41233",
      });
      // A finished attempt leaves room for the next one, and cancelling it dismisses it.
      yield* service.startWifiPairing({ requestId: "web-2" });
    }).pipe(withSettings(), Effect.scoped),
  );

  it.effect("reports why an attempt failed", () =>
    Effect.gen(function* () {
      const { service } = yield* harness(() =>
        Effect.succeed({ code: 127, stdout: "", stderr: "spawn adb ENOENT" }),
      );
      const subscription = yield* service.subscribe;
      yield* service.startWifiPairing({ requestId: "web-1" });
      let pairing = (yield* PubSub.take(subscription)).wifiPairing;
      while (pairing?.status !== "failed") pairing = (yield* PubSub.take(subscription)).wifiPairing;
      expect(pairing).toMatchObject({ status: "failed", reason: "adb_missing" });
    }).pipe(withSettings(), Effect.scoped),
  );

  it.effect("forgets a Wi-Fi phone, ending what was open on it, and refuses other devices", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      const { service } = yield* harness(adbWaiting(commands, () => "disconnected"));
      const wifi = DeviceId.make(wifiPhone.id);
      yield* service.open({ ...on(wifiPhone.id), platform: "android" });
      yield* service.setHold({ deviceId: wifi, held: true });

      const forgotten = yield* service.forgetDevice({ deviceId: wifi });
      expect(commands).toContainEqual(["disconnect", wifiPhone.id]);
      expect(forgotten.sessions).toEqual([]);
      expect(forgotten.holds).toEqual([]);

      expect(
        yield* Effect.flip(service.forgetDevice({ deviceId: DeviceId.make(phone.id) })),
      ).toMatchObject({ _tag: "DeviceActionUnavailableError", reason: "not_wifi" });
      expect(
        yield* Effect.flip(service.forgetDevice({ deviceId: DeviceId.make("gone") })),
      ).toMatchObject({ _tag: "DeviceNotFoundError" });
    }).pipe(withSettings(), Effect.scoped),
  );

  it.effect("treats a phone adb already let go as forgotten and reports other failures", () =>
    Effect.gen(function* () {
      let answer = { code: 1, stdout: "", stderr: "error: no such device '192.168.1.20:41233'" };
      const { service } = yield* harness(() => Effect.sync(() => answer));
      const wifi = { deviceId: DeviceId.make(wifiPhone.id) };
      yield* service.forgetDevice(wifi);
      answer = { code: 1, stdout: "", stderr: "error: cannot reach adb server" };
      expect(yield* Effect.flip(service.forgetDevice(wifi))).toMatchObject({
        _tag: "DeviceOperationError",
        operation: "forget",
      });
    }).pipe(withSettings(), Effect.scoped),
  );
});
