import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as CryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ComputerUseError,
  DeviceHeldError,
  DeviceId,
  LOCAL_DEVICE_HOST_ID,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ComputerUse from "./ComputerUse.ts";

const caller: ComputerUse.ComputerUseCaller = {
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  threadTitle: "Tidy settings",
};

const permissionsJson = (screenRecording: string, accessibility: string, automation: string) =>
  JSON.stringify({ screenRecording, accessibility, automation });
const GRANTED = permissionsJson("granted", "granted", "granted");

interface Call {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

const envelope = (command: string, data: unknown) =>
  JSON.stringify({ version: "2.6", ok: true, command, data });
const failure = (command: string, code: string, retry: string, suggestion = "Try again.") =>
  JSON.stringify({
    ok: false,
    command,
    error: { code, message: `${code} happened.`, suggestion, disposition: { retry } },
  });
const node = (ref: string, role: string, name: string, children: unknown[] = []) => ({
  ref_id: ref,
  role,
  name,
  available_actions: ["click"],
  children,
});

/** A 1920x1080 PNG header: all the service reads of a capture it did not resize. */
const PNG_1920_1080 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 7, 128, 0, 0,
  4, 56,
]);
const isDesktop = (command: string) =>
  command.endsWith("/agent-desktop") || command.endsWith(".exe");

const harness = (options: {
  readonly platform?: NodeJS.Platform;
  /** What the server process sees; decides the Linux session. */
  readonly env?: NodeJS.ProcessEnv;
  readonly arch?: NodeJS.Architecture;
  readonly permissions?: string;
  readonly png?: Uint8Array;
  /** A database shared by several instances, as a restarted server finds it. */
  readonly database?: Layer.Layer<SqlClient.SqlClient>;
  /** What agent-desktop prints for one call; defaults to an ok envelope. */
  readonly desktop?: (args: ReadonlyArray<string>) => string;
  /** Whether the managed `npm install` of agent-desktop works. */
  readonly installFails?: boolean;
  /** The user holds this computer, as the device panel's Take over does. */
  readonly held?: { current: boolean };
}) => {
  const calls: Call[] = [];
  const gated: Array<Parameters<DeviceService.DeviceService["Service"]["authorizeAgent"]>[0]> = [];
  /** The mock runner is the only way anything could touch the Mac. */
  const scripted = (marker: string) => calls.filter((call) => call.args[3]?.includes(marker));
  const desktopCalls = () => calls.filter((call) => isDesktop(call.command));
  const runner = Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            calls.push({
              command: input.command,
              args: input.args,
              stdin: input.stdin,
              env: input.env,
            });
            const script = input.args[3] ?? "";
            let stdout = "";
            let code = 0;
            if (input.command === "npm") {
              code = options.installFails === true ? 1 : 0;
              if (code === 0) {
                const prefix = input.args[input.args.indexOf("--prefix") + 1]!;
                const bin = `${prefix}/node_modules/agent-desktop/bin`;
                yield* fs.makeDirectory(bin, { recursive: true });
                yield* fs.writeFileString(`${bin}/agent-desktop`, "");
              }
            } else if (isDesktop(input.command)) {
              stdout = (options.desktop ?? ((args) => envelope(args[0]!, {})))(input.args);
              if (input.args[0] === "screenshot" && stdout.includes('"ok":true')) {
                yield* fs.writeFile(input.args[3]!, options.png ?? PNG_1920_1080);
              }
            } else if (script.includes("CGPreflight")) stdout = options.permissions ?? GRANTED;
            else if (script.includes("NSScreen")) stdout = "100 50\n";
            else if (script.includes("frontmost")) stdout = "System Settings\n";
            else if (input.command.endsWith("screencapture")) {
              yield* fs.writeFile(input.args.at(-1)!, options.png ?? new Uint8Array(4_096).fill(7));
            }
            return {
              stdout,
              stderr: "",
              code,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            } as never;
          }).pipe(Effect.orDie),
      });
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, CryptoLayer.layer)));
  const decisions = DecisionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        options.database ?? SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );
  const layer = ComputerUse.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Environment, options.env ?? {}),
        Layer.succeed(HostProcess.Architecture, options.arch ?? "x64"),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        runner,
        decisions,
        Layer.mock(DeviceService.DeviceService)({
          authorizeAgent: (input) =>
            Effect.suspend(() => {
              gated.push(input);
              return options.held?.current
                ? Effect.fail(
                    new DeviceHeldError({
                      hostId: input.hostId,
                      deviceId: input.deviceId,
                      since: "2026-11-11T10:00:00.000Z",
                    }),
                  )
                : Effect.void;
            }),
        }),
        ServerConfig.layerTest("/tmp", { prefix: "t3-computer-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        Layer.mergeAll(NodeServices.layer, CryptoLayer.layer),
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
  );
  return { calls, scripted, desktopCalls, gated, layer };
};

/** Resolves once an open decision exists; the stream ends the moment it does, so nothing sleeps. */
const openDecision = Effect.gen(function* () {
  const decisions = yield* DecisionService.DecisionService;
  yield* decisions.subscribe.pipe(
    Stream.map((event) =>
      event.type === "snapshot"
        ? event.decisions.find((decision) => decision.status === "open")
        : event.decision.status === "open"
          ? event.decision
          : undefined,
    ),
    Stream.filter((found) => found !== undefined),
    Stream.runHead,
  );
  const open = (yield* decisions.list({})).find((decision) => decision.status === "open")!;
  return open;
});

const approve = Effect.gen(function* () {
  const decisions = yield* DecisionService.DecisionService;
  const pending = yield* openDecision;
  yield* decisions.answer({ decisionId: pending.id, optionId: "accept" });
  return pending;
});

describe("parsePermissions", () => {
  it("reads each status and never guesses from unreadable output", () => {
    for (const [stdout, expected] of [
      [GRANTED, ["granted", "granted", "granted"]],
      [permissionsJson("denied", "granted", "x"), ["denied", "granted", "unknown"]],
      ["not json", ["unknown", "unknown", "unknown"]],
      ["", ["unknown", "unknown", "unknown"]],
      ["null", ["unknown", "unknown", "unknown"]],
    ] satisfies ReadonlyArray<readonly [string, ReadonlyArray<string>]>) {
      const parsed = ComputerUse.parsePermissions(stdout);
      assert.deepEqual([parsed.screenRecording, parsed.accessibility, parsed.automation], expected);
      assert.isTrue(parsed.supported);
    }
  });

  // The mocked runner cannot catch a bridge function macOS stops exposing (macOS 27 did).
  it.live.runIf(HostProcess.Platform.defaultValue() === "darwin")(
    "the real script reads both permissions",
    () =>
      Effect.gen(function* () {
        const output = yield* (yield* ProcessRunner.ProcessRunner).run({
          command: "/usr/bin/osascript",
          args: ["-l", "JavaScript", "-e", ComputerUse.PERMISSIONS_SCRIPT],
        });
        const parsed = ComputerUse.parsePermissions(output.stdout);
        assert.notEqual(parsed.screenRecording, "unknown", output.stderr);
        assert.notEqual(parsed.accessibility, "unknown", output.stderr);
      }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)))),
  );
});

describe("ComputerUse", () => {
  it.effect("is unsupported off macOS and runs nothing", () => {
    const { calls, layer } = harness({ platform: "linux" });
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      assert.isFalse((yield* computer.permissions({ automation: false })).supported);
      const errors = [
        yield* Effect.flip(computer.screenshot),
        yield* Effect.flip(computer.click(caller, { target: "the Save button", x: 1, y: 1 })),
        yield* Effect.flip(computer.type(caller, { target: "the Save button", text: "a" })),
        yield* Effect.flip(computer.key(caller, { target: "the Save button", key: "a" })),
        yield* Effect.flip(computer.openSettings({ pane: "accessibility" })),
      ];
      for (const error of errors) assert.equal(error.reason, "unsupported_platform");
      assert.equal(calls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens the right System Settings pane", () => {
    const { calls, layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      yield* computer.openSettings({ pane: "screen-recording" });
      yield* computer.openSettings({ pane: "accessibility" });
      yield* computer.openSettings({ pane: "automation" });
      assert.deepEqual(
        calls.map((call) => [call.command, call.args[0]?.split("?")[1]]),
        [
          ["/usr/bin/open", "Privacy_ScreenCapture"],
          ["/usr/bin/open", "Privacy_Accessibility"],
          ["/usr/bin/open", "Privacy_Automation"],
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("a screenshot is resized to screen points", () => {
    const { calls, layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const shot = yield* computer.screenshot;
      assert.deepEqual([shot.width, shot.height, shot.png.byteLength], [100, 50, 4_096]);
      const sips = calls.find((call) => call.command === "/usr/bin/sips");
      assert.deepEqual(sips?.args.slice(0, 3), ["-z", "50", "100"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a screenshot without the permission, or an empty capture, says Screen Recording is missing",
    () => {
      const denied = harness({ permissions: permissionsJson("denied", "granted", "granted") });
      const empty = harness({ png: new Uint8Array(10) });
      return Effect.gen(function* () {
        const deniedError = yield* ComputerUse.ComputerUse.use(
          (computer) => computer.screenshot,
        ).pipe(Effect.flip, Effect.provide(denied.layer));
        assert.equal(deniedError.reason, "screen_recording_missing");
        const emptyError = yield* ComputerUse.ComputerUse.use(
          (computer) => computer.screenshot,
        ).pipe(Effect.flip, Effect.provide(empty.layer));
        assert.equal(emptyError.reason, "screen_recording_missing");
      });
    },
  );

  it.effect("a large capture is still blank when Screen Recording is denied", () => {
    const { layer } = harness({
      permissions: permissionsJson("denied", "granted", "granted"),
      png: new Uint8Array(50_000).fill(1),
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(ComputerUse.ComputerUse.use((c) => c.screenshot));
      assert.equal(error.reason, "screen_recording_missing");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads Automation only when asked, since that can make macOS prompt", () => {
    const { calls, layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      assert.equal((yield* computer.permissions({ automation: false })).automation, "granted");
      assert.deepEqual(calls[0]!.args.slice(4), []);
      yield* computer.permissions({ automation: true });
      assert.deepEqual(calls[1]!.args.slice(4), ["automation"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the approval names the target, the action and the app in front", () => {
    const { layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const decisions = yield* DecisionService.DecisionService;
      const fiber = yield* Effect.forkChild(
        computer.click(caller, { target: "the blue Save button", x: 10, y: 20 }),
      );
      const pending = yield* openDecision;
      assert.equal(pending.title, "the blue Save button: click at (10, 20)");
      assert.include(pending.context, "**Target:** the blue Save button");
      assert.include(pending.context, "(10, 20)");
      assert.include(pending.context, "**App in front:** System Settings");
      yield* decisions.dismiss(pending.id);
      yield* Effect.flip(Fiber.join(fiber));
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses input without a target, before asking anyone", () => {
    const { calls, layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const decisions = yield* DecisionService.DecisionService;
      for (const target of ["", "   ", "t".repeat(201)]) {
        assert.equal(
          (yield* Effect.flip(computer.click(caller, { target, x: 1, y: 1 }))).reason,
          "invalid",
        );
        assert.equal(
          (yield* Effect.flip(computer.type(caller, { target, text: "a" }))).reason,
          "invalid",
        );
        assert.equal(
          (yield* Effect.flip(computer.key(caller, { target, key: "a" }))).reason,
          "invalid",
        );
      }
      assert.equal((yield* decisions.list({})).length, 0);
      assert.equal(calls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses input without Accessibility or Automation, before asking anyone", () => {
    const noAccessibility = harness({
      permissions: permissionsJson("granted", "denied", "granted"),
    });
    const noAutomation = harness({ permissions: permissionsJson("granted", "granted", "denied") });
    return Effect.gen(function* () {
      const click = yield* ComputerUse.ComputerUse.use((computer) =>
        computer.click(caller, { target: "the Save button", x: 5, y: 5 }),
      ).pipe(Effect.flip, Effect.provide(noAccessibility.layer));
      assert.equal(click.reason, "accessibility_missing");
      const typed = yield* ComputerUse.ComputerUse.use((computer) =>
        computer.type(caller, { target: "the Save button", text: "x" }),
      ).pipe(Effect.flip, Effect.provide(noAutomation.layer));
      assert.equal(typed.reason, "accessibility_missing");
      assert.include(typed.message, "Automation");
      // A click needs no Automation, so it gets as far as asking.
      const decisions = yield* DecisionService.DecisionService.use((service) =>
        service.list({}),
      ).pipe(Effect.provide(noAccessibility.layer));
      assert.equal(decisions.length, 0);
    });
  });

  it.effect("rejects arguments that make no sense", () => {
    const { layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const bad = [
        computer.click(caller, { target: "the Save button", x: -1, y: 0 }),
        computer.click(caller, { target: "the Save button", x: Number.NaN, y: 0 }),
        computer.type(caller, { target: "the Save button", text: "" }),
        computer.type(caller, { target: "the Save button", text: "x".repeat(2_001) }),
        computer.key(caller, { target: "the Save button", key: "" }),
        computer.key(caller, { target: "the Save button", key: "notakey" }),
        computer.key(caller, { target: "the Save button", key: "a", modifiers: ["hyper"] }),
      ];
      for (const effect of bad) assert.equal((yield* Effect.flip(effect)).reason, "invalid");
    }).pipe(Effect.provide(layer));
  });

  it.effect("approving a click acts exactly once, and a repeat never acts twice", () => {
    const { scripted, layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const decisions = yield* DecisionService.DecisionService;
      const first = yield* Effect.forkChild(
        computer.click(caller, { target: "the Save button", x: 10.4, y: 20, button: "right" }),
      );
      const pending = yield* openDecision;
      assert.equal(pending.title, "the Save button: click at (10, 20)");
      assert.deepEqual(
        pending.options.map((option) => option.label),
        ["Approve", "Deny"],
      );
      // Nothing moved the mouse while the decision was open.
      assert.equal(scripted("CGEventPost").length, 0);
      yield* decisions.answer({ decisionId: pending.id, optionId: "accept" });
      yield* Fiber.join(first);
      assert.equal(scripted("CGEventPost").length, 1);
      assert.deepEqual(scripted("CGEventPost")[0]!.args.slice(4), ["10", "20", "right", "1"]);
      // The same call again lands on the same, already used decision.
      const again = yield* Effect.flip(
        computer.click(caller, { target: "the Save button", x: 10, y: 20, button: "right" }),
      );
      assert.equal(again.reason, "already_executed");
      assert.equal(scripted("CGEventPost").length, 1);
      assert.equal((yield* decisions.list({})).length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a held computer refuses input and snapshots but still takes screenshots", () => {
    const held = { current: true };
    const { scripted, gated, layer } = harness({ held });
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const decisions = yield* DecisionService.DecisionService;
      const click = { target: "the Save button", x: 10, y: 20 };
      const refused = yield* Effect.flip(computer.click(caller, click));
      assert.equal(refused.reason, "desktop_refused");
      assert.include(refused.message, "computer_screenshot still works");
      assert.equal((yield* Effect.flip(computer.snapshot(caller, {}))).reason, "desktop_refused");
      // Nobody was asked to approve an action the hold refuses.
      assert.equal((yield* decisions.list({})).length, 0);
      yield* computer.screenshot;
      const { agent, ...gate } = gated[0]!;
      assert.deepEqual(gate, {
        threadId: caller.threadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: DeviceId.make("desktop"),
        intent: "open",
      });
      assert.equal(agent?.threadTitle, caller.threadTitle);
      assert.isFunction(agent?.ask);
      assert.equal(gated.length, 2);

      // Taken over while the approval waits: nothing acts, and the approval stays usable.
      held.current = false;
      const pending = yield* Effect.forkChild(Effect.flip(computer.click(caller, click)));
      const decision = yield* openDecision;
      held.current = true;
      yield* decisions.answer({ decisionId: decision.id, optionId: "accept" });
      assert.equal((yield* Fiber.join(pending)).reason, "desktop_refused");
      assert.equal(scripted("CGEventPost").length, 0);
      held.current = false;
      yield* computer.click(caller, click);
      assert.equal(scripted("CGEventPost").length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an approved action never repeats after a restart", () =>
    Effect.gen(function* () {
      const database = Layer.succeedContext(yield* Layer.build(SqlitePersistence.layerMemory));
      const before = harness({ database });
      const after = harness({ database });
      yield* Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        const decisions = yield* DecisionService.DecisionService;
        const fiber = yield* Effect.forkChild(
          computer.click(caller, { target: "the Save button", x: 10, y: 20 }),
        );
        const pending = yield* openDecision;
        yield* decisions.answer({ decisionId: pending.id, optionId: "accept" });
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(before.layer));
      assert.equal(before.scripted("CGEventPost").length, 1);
      // A fresh service over the same stored decisions: the same call must not act again.
      const again = yield* ComputerUse.ComputerUse.use((computer) =>
        computer.click(caller, { target: "the Save button", x: 10, y: 20 }),
      ).pipe(Effect.flip, Effect.provide(after.layer));
      assert.equal(again.reason, "already_executed");
      assert.equal(after.scripted("CGEventPost").length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("a denied, dismissed or free-text answer never acts", () => {
    const { scripted, layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const decisions = yield* DecisionService.DecisionService;
      const settle = [
        (id: DecisionService.DecisionRequestInput["fromThreadId"] extends never ? never : string) =>
          decisions.answer({ decisionId: id as never, optionId: "deny" }),
        (id: string) => decisions.dismiss(id as never),
        (id: string) => decisions.answer({ decisionId: id as never, text: "approve" }),
      ];
      for (const [index, settleOne] of settle.entries()) {
        const fiber = yield* Effect.forkChild(
          computer.key(caller, {
            target: "the Save button",
            key: "a",
            modifiers: ["command"],
            clientRequestId: `k${index}`,
          }),
        );
        const open = yield* openDecision;
        yield* settleOne(open.id);
        assert.equal((yield* Effect.flip(Fiber.join(fiber))).reason, "not_approved");
      }
      assert.equal(scripted("keystroke").length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an expired decision never acts", () => {
    const { scripted, layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const decisions = yield* DecisionService.DecisionService;
      const fiber = yield* Effect.forkChild(
        computer.type(caller, { target: "the Save button", text: "hello" }),
      );
      yield* openDecision;
      yield* TestClock.adjust("31 minutes");
      yield* decisions.expireDue;
      const error = yield* Effect.flip(Fiber.join(fiber));
      assert.oneOf(error.reason, ["not_approved", "approval_pending"]);
      // Asking again joins the expired decision, which is not approval.
      assert.equal(
        (yield* Effect.flip(computer.type(caller, { target: "the Save button", text: "hello" })))
          .reason,
        "not_approved",
      );
      assert.equal(scripted("keystroke").length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("waiting out the window leaves the decision open and does nothing", () => {
    const { scripted, layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const decisions = yield* DecisionService.DecisionService;
      const fiber = yield* Effect.forkChild(
        computer.type(caller, { target: "the Save button", text: "hi" }),
      );
      yield* openDecision;
      yield* TestClock.adjust("2 minutes");
      assert.equal((yield* Effect.flip(Fiber.join(fiber))).reason, "approval_pending");
      assert.equal((yield* decisions.list({}))[0]!.status, "open");
      assert.equal(scripted("keystroke").length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("typed text and keys travel as arguments, never inside the script", () => {
    const { scripted, layer } = harness({});
    const hostile = `"; do shell script "rm -rf ~" #'`;
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const decisions = yield* DecisionService.DecisionService;
      const typing = yield* Effect.forkChild(
        computer.type(caller, { target: "the Save button", text: hostile }),
      );
      const typed = yield* openDecision;
      yield* decisions.answer({ decisionId: typed.id, optionId: "accept" });
      yield* Fiber.join(typing);
      const pressing = yield* Effect.forkChild(
        computer.key(caller, {
          target: "the Save button",
          key: "Return",
          modifiers: ["Shift", "command"],
        }),
      );
      const pressed = yield* openDecision;
      assert.equal(pressed.title, "the Save button: press command+shift+return");
      yield* decisions.answer({ decisionId: pressed.id, optionId: "accept" });
      yield* Fiber.join(pressing);
      const keyboard = scripted("keystroke");
      assert.equal(keyboard.length, 2);
      assert.deepEqual(keyboard[0]!.args.slice(4), ["text", hostile]);
      assert.deepEqual(keyboard[1]!.args.slice(4), ["code", "36", "command", "shift"]);
      for (const call of keyboard) assert.notInclude(call.args[3]!, "rm -rf");
    }).pipe(Effect.provide(layer));
  });

  it.effect("the same action without a request id asks once; an explicit new id asks again", () => {
    const { layer } = harness({});
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const decisions = yield* DecisionService.DecisionService;
      const a = yield* Effect.forkChild(
        computer.key(caller, { target: "the Save button", key: "a" }),
      );
      yield* openDecision;
      const b = yield* Effect.forkChild(
        computer.key(caller, { target: "the Save button", key: "a" }),
      );
      yield* TestClock.adjust("2 minutes");
      assert.equal((yield* Effect.flip(Fiber.join(a))).reason, "approval_pending");
      assert.equal((yield* Effect.flip(Fiber.join(b))).reason, "approval_pending");
      assert.equal((yield* decisions.list({})).length, 1);
      const c = yield* Effect.forkChild(
        computer.key(caller, { target: "the Save button", key: "a", clientRequestId: "again" }),
      );
      yield* TestClock.adjust("2 minutes");
      yield* Effect.flip(Fiber.join(c));
      assert.equal((yield* decisions.list({})).length, 2);
    }).pipe(Effect.provide(layer));
  });
  describe("by accessibility ref", () => {
    const tree = {
      app: "Notes",
      complete: true,
      window: { id: "w1", title: "All Notes" },
      tree: node("@s1:e1", "window", "", [
        node("@s1:e2", "button", "New Note"),
        { role: "group", name: "no ref", children: [node("@s1:e3", "textfield", "Search\nbox")] },
      ]),
    };
    const snapshotOnly = () => envelope("snapshot", tree);
    it.effect("a snapshot lists the elements with refs, installs once and asks nobody", () => {
      const { desktopCalls, calls, layer } = harness({ desktop: snapshotOnly });
      return Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        const decisions = yield* DecisionService.DecisionService;
        const shot = yield* computer.snapshot(caller, { app: "Notes" });
        assert.deepEqual(
          [shot.app, shot.window, shot.complete, shot.refCount, shot.truncated],
          ["Notes", "All Notes", true, 3, false],
        );
        assert.deepEqual(
          shot.nodes.map((n) => [n.ref, n.role, n.name]),
          [
            ["@s1:e1", "window", ""],
            ["@s1:e2", "button", "New Note"],
            ["@s1:e3", "textfield", "Search box"],
          ],
        );
        yield* computer.snapshot(caller, { root: "@s1:e1" });
        assert.equal(calls.filter((call) => call.command === "npm").length, 1);
        const [first, second] = desktopCalls();
        assert.deepEqual(first!.args, [
          "snapshot",
          "-i",
          "--compact",
          "--app",
          "Notes",
          "--session",
          "t3-thread-1",
        ]);
        assert.deepEqual(second!.args.slice(3, 5), ["--root", "@s1:e1"]);
        assert.match(first!.env!.AGENT_DESKTOP_HOME!, /tools\/agent-desktop\/state$/);
        assert.equal((yield* decisions.list({})).length, 0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("a big snapshot is cut and says so", () => {
      const many = {
        ...tree,
        tree: node(
          "@s1:e0",
          "window",
          "",
          Array.from({ length: 400 }, (_, i) => node(`@s1:e${i + 1}`, "button", "b".repeat(200))),
        ),
      };
      const { layer } = harness({ desktop: () => envelope("snapshot", many) });
      return Effect.gen(function* () {
        const shot = yield* ComputerUse.ComputerUse.use((c) => c.snapshot(caller, {}));
        assert.equal(shot.nodes.length, 300);
        assert.equal(shot.refCount, 401);
        assert.equal(shot.truncated, true);
        assert.equal(shot.nodes[1]!.name.length, 80);
      }).pipe(Effect.provide(layer));
    });

    it.effect("snapshot refuses flag-like input before running anything", () => {
      const { desktopCalls, layer } = harness({ desktop: snapshotOnly });
      return Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        for (const input of [{ app: "--force" }, { app: " " }, { root: "e2" }, { root: "--x" }]) {
          assert.equal((yield* Effect.flip(computer.snapshot(caller, input))).reason, "invalid");
        }
        assert.equal(desktopCalls().length, 0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("snapshot without Accessibility says so and runs nothing", () => {
      const { desktopCalls, layer } = harness({
        permissions: permissionsJson("granted", "denied", "granted"),
      });
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          ComputerUse.ComputerUse.use((c) => c.snapshot(caller, {})),
        );
        assert.equal(error.reason, "accessibility_missing");
        assert.equal(desktopCalls().length, 0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("a click by ref names the element and runs one headless click", () => {
      const { desktopCalls, layer } = harness({
        desktop: (args) => (args[0] === "snapshot" ? snapshotOnly() : envelope(args[0]!, {})),
      });
      return Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        yield* computer.snapshot(caller, {});
        const fiber = yield* Effect.forkChild(
          computer.click(caller, { target: "the New Note button", ref: "@s1:e2" }),
        );
        const pending = yield* approve;
        assert.equal(pending.title, 'the New Note button: click button "New Note" (@s1:e2)');
        assert.include(pending.context, 'button "New Note" (@s1:e2)');
        yield* Fiber.join(fiber);
        assert.deepEqual(desktopCalls().at(-1)!.args, [
          "click",
          "@s1:e2",
          "--session",
          "t3-thread-1",
        ]);
        // Same ref again: same decision, already used.
        const again = yield* Effect.flip(
          computer.click(caller, { target: "the New Note button", ref: "@s1:e2" }),
        );
        assert.equal(again.reason, "already_executed");
        assert.equal(desktopCalls().filter((c) => c.args[0] === "click").length, 1);
      }).pipe(Effect.provide(layer));
    });

    it.effect("a right click by ref uses right-click; the ref names itself when unseen", () => {
      const { desktopCalls, layer } = harness({});
      return Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        const fiber = yield* Effect.forkChild(
          computer.click(caller, { target: "a row", ref: "@s9:e4", button: "right" }),
        );
        const pending = yield* approve;
        assert.equal(pending.title, "a row: right-click @s9:e4");
        yield* Fiber.join(fiber);
        assert.equal(desktopCalls().at(-1)!.args[0], "right-click");
      }).pipe(Effect.provide(layer));
    });

    it.effect("typing into a ref sends the text on stdin, never in argv", () => {
      const { desktopCalls, scripted, layer } = harness({});
      return Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        const fiber = yield* Effect.forkChild(
          computer.type(caller, {
            target: "the search field",
            ref: "@s1:e3",
            text: "secret words",
          }),
        );
        yield* approve;
        yield* Fiber.join(fiber);
        const call = desktopCalls().at(-1)!;
        assert.deepEqual(call.args, ["type", "@s1:e3", "--stdin", "--session", "t3-thread-1"]);
        assert.equal(call.stdin, "secret words");
        assert.equal(scripted("keystroke").length, 0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("a ref and coordinates together, or a bad ref, are refused before asking", () => {
      const { desktopCalls, layer } = harness({});
      return Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        const decisions = yield* DecisionService.DecisionService;
        const refused = [
          computer.click(caller, { target: "t", ref: "@s1:e2", x: 1, y: 2 }),
          computer.click(caller, { target: "t", ref: "@s1:e2", double: true }),
          computer.click(caller, { target: "t", ref: "--force" }),
          computer.click(caller, { target: "t" }),
          computer.type(caller, { target: "t", ref: "e2", text: "a" }),
        ];
        for (const attempt of refused)
          assert.equal((yield* Effect.flip(attempt)).reason, "invalid");
        assert.equal((yield* decisions.list({})).length, 0);
        assert.equal(desktopCalls().length, 0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("errors map to what the agent should do next", () => {
      const cases = [
        ["STALE_REF", "safe", "invalid", "snapshot"],
        ["ELEMENT_NOT_FOUND", "unknown", "invalid", "ELEMENT_NOT_FOUND happened."],
        ["PERM_DENIED", "safe", "accessibility_missing", "Accessibility"],
        ["ACTION_FAILED", "safe", "failed", "Try again."],
      ] as const;
      return Effect.forEach(cases, ([code, retry, reason, text]) => {
        const { layer } = harness({ desktop: (args) => failure(args[0]!, code, retry) });
        return Effect.gen(function* () {
          const computer = yield* ComputerUse.ComputerUse;
          const fiber = yield* Effect.forkChild(
            computer.click(caller, { target: "a button", ref: "@s1:e2" }),
          );
          yield* approve;
          const error = yield* Effect.flip(Fiber.join(fiber));
          assert.equal(error.reason, reason);
          assert.include(error.message, text);
        }).pipe(Effect.provide(layer));
      });
    });

    it.effect("an action that may have acted is not repeated, a safe failure can be", () => {
      const unsafe = harness({ desktop: (args) => failure(args[0]!, "ACTION_FAILED", "unsafe") });
      const safe = harness({ desktop: (args) => failure(args[0]!, "ACTION_FAILED", "safe") });
      const attempt = Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        const fiber = yield* Effect.forkChild(
          computer.click(caller, { target: "a button", ref: "@s1:e2" }),
        );
        yield* approve;
        yield* Effect.flip(Fiber.join(fiber));
        return yield* Effect.flip(computer.click(caller, { target: "a button", ref: "@s1:e2" }));
      });
      return Effect.gen(function* () {
        const afterUnsafe = yield* attempt.pipe(Effect.provide(unsafe.layer));
        assert.equal(afterUnsafe.reason, "already_executed");
        assert.equal(unsafe.desktopCalls().length, 1);
        const afterSafe = yield* attempt.pipe(Effect.provide(safe.layer));
        // Released, so the retry runs the click again.
        assert.equal(afterSafe.reason, "failed");
        assert.equal(safe.desktopCalls().length, 2);
      });
    });

    it.effect("unreadable output and timeouts are failures that ask for a snapshot", () => {
      const { layer } = harness({ desktop: () => "not json" });
      return Effect.gen(function* () {
        const error = yield* ComputerUse.ComputerUse.use((c) => c.snapshot(caller, {})).pipe(
          Effect.flip,
        );
        assert.equal(error.reason, "failed");
        assert.include(error.message, "no usable answer");
      }).pipe(Effect.provide(layer));
    });

    it.effect("without npm or network, snapshot says so and coordinates still work", () => {
      const { scripted, layer } = harness({ installFails: true });
      return Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        const error = yield* Effect.flip(computer.snapshot(caller, {}));
        assert.equal(error.reason, "failed");
        assert.include(error.message, "could not be installed");
        assert.include(error.message, "computer_screenshot");
        const fiber = yield* Effect.forkChild(
          computer.click(caller, { target: "the Save button", x: 10, y: 20 }),
        );
        yield* approve;
        yield* Fiber.join(fiber);
        assert.equal(scripted("CGEventPost").length, 1);
      }).pipe(Effect.provide(layer));
    });
  });
});

describe("detectHost", () => {
  it.each([
    ["darwin", {}, "mac"],
    ["win32", {}, "windows"],
    ["linux", { DISPLAY: ":0" }, "x11"],
    ["linux", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, "wayland"],
    ["linux", { WAYLAND_DISPLAY: "" }, "headless"],
    ["freebsd", { DISPLAY: ":0" }, "unsupported"],
  ] as const)("%s with %o is %s", (platform, env, host) => {
    assert.equal(ComputerUse.detectHost(platform, env), host);
  });
});

describe("ComputerUse on Windows and Linux", () => {
  const SESSION = ["--session", "t3-thread-1"];
  const hosts = [
    {
      name: "win32",
      platform: "win32",
      env: {},
      arch: "arm64",
      binary: "/bin/agent-desktop-win32-arm64.exe",
      headed: ["--headed"],
      pointer: true,
      report: {
        os: "win32",
        display: undefined,
        states: "available available available available",
      },
    },
    {
      name: "linux-x11",
      platform: "linux",
      env: { DISPLAY: ":0" },
      arch: "x64",
      binary: "/bin/agent-desktop",
      headed: [],
      pointer: true,
      report: { os: "linux", display: "x11", states: "available limited limited available" },
    },
    {
      name: "linux-wayland",
      platform: "linux",
      env: { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
      arch: "x64",
      binary: "/bin/agent-desktop",
      headed: [],
      pointer: false,
      report: { os: "linux", display: "wayland", states: "available consent unavailable limited" },
    },
  ] as const;

  it.effect.each(hosts)(
    "$name: every action is one agent-desktop command, or a named limit",
    (host) => {
      const { calls, desktopCalls, layer } = harness(host);
      return Effect.gen(function* () {
        const computer = yield* ComputerUse.ComputerUse;
        const decisions = yield* DecisionService.DecisionService;
        const act = (action: Effect.Effect<void, ComputerUseError>) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(action);
            const pending = yield* approve;
            yield* Fiber.join(fiber);
            return pending;
          });

        const report = yield* computer.permissions({ automation: true });
        assert.isFalse(report.supported);
        assert.equal(report.host?.os, host.report.os);
        assert.equal(report.host?.display, host.report.display);
        assert.equal(
          report.host?.capabilities.map((capability) => capability.state).join(" "),
          host.report.states,
        );
        assert.deepEqual(
          report.host?.capabilities.map((capability) => capability.key),
          ["elements", "screenshot", "pointer", "keyboard"],
        );
        // The report is static: reading it runs and installs nothing.
        assert.equal(calls.length, 0);

        const shot = yield* computer.screenshot;
        assert.deepEqual([shot.width, shot.height], [1920, 1080]);
        const capture = desktopCalls().at(-1)!;
        assert.isTrue(capture.command.endsWith(host.binary));
        assert.deepEqual(capture.args.slice(0, 3), ["screenshot", "--screen", "0"]);
        assert.equal(capture.args.length, 4);

        const click = computer.click(caller, {
          target: "the Save button",
          x: 10.4,
          y: 20,
          button: "right",
          double: true,
        });
        if (host.pointer) {
          const pending = yield* act(click);
          assert.include(pending.context, "on this computer's main screen");
          assert.equal(pending.options[0]!.consequence, "The agent acts on this computer once");
          assert.deepEqual(desktopCalls().at(-1)!.args, [
            "mouse-click",
            "--xy",
            "10,20",
            "--button",
            "right",
            "--count",
            "2",
            "--headed",
            ...SESSION,
          ]);
        } else {
          const error = yield* Effect.flip(click);
          assert.equal(error.reason, "unsupported_platform");
          assert.include(error.message, "Wayland");
          assert.include(error.message, "ref");
        }

        yield* act(
          computer.click(caller, { target: "the Save button", ref: "@s1:e2", button: "right" }),
        );
        assert.deepEqual(desktopCalls().at(-1)!.args, [
          "right-click",
          "@s1:e2",
          ...host.headed,
          ...SESSION,
        ]);
        yield* act(computer.click(caller, { target: "the Save button", ref: "@s1:e2" }));
        assert.deepEqual(desktopCalls().at(-1)!.args, ["click", "@s1:e2", ...SESSION]);

        yield* act(computer.type(caller, { target: "the title field", ref: "@s1:e1", text: "hi" }));
        assert.deepEqual(desktopCalls().at(-1)!.args, [
          "type",
          "@s1:e1",
          "--stdin",
          ...host.headed,
          ...SESSION,
        ]);
        assert.equal(desktopCalls().at(-1)!.stdin, "hi");

        yield* act(
          computer.key(caller, { target: "the editor", key: "s", modifiers: ["shift", "command"] }),
        );
        assert.deepEqual(desktopCalls().at(-1)!.args, ["press", "cmd+shift+s", ...SESSION]);
        yield* act(computer.key(caller, { target: "the editor", key: "Return" }));
        assert.deepEqual(desktopCalls().at(-1)!.args, ["press", "return", ...SESSION]);

        // Refused before anyone is asked: nothing ran and no decision was opened for them.
        const ran = desktopCalls().length;
        const asked = (yield* decisions.list({})).length;
        const typed = yield* Effect.flip(computer.type(caller, { target: "the field", text: "a" }));
        assert.equal(typed.reason, "unsupported_platform");
        assert.include(typed.message, "needs a `ref`");
        for (const key of ["home", "enter", "+", "-"]) {
          const error = yield* Effect.flip(computer.key(caller, { target: "the editor", key }));
          assert.equal(error.reason, "invalid");
          assert.include(error.message, "On Windows and Linux key must be");
        }
        const settings = yield* Effect.flip(computer.openSettings({ pane: "accessibility" }));
        assert.equal(settings.reason, "unsupported_platform");
        assert.equal(desktopCalls().length, ran);
        assert.equal((yield* decisions.list({})).length, asked);
        // Nothing but the installer and agent-desktop ever ran: no macOS script reached this host.
        assert.isTrue(calls.every((call) => call.command === "npm" || isDesktop(call.command)));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a Linux server without a graphical session refuses everything and says why", () => {
    const { calls, layer } = harness({ platform: "linux", env: { DISPLAY: "" } });
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const report = yield* computer.permissions({ automation: false });
      assert.equal(report.host?.display, "none");
      assert.isTrue(report.host?.capabilities.every((entry) => entry.state === "unavailable"));
      const errors = [
        yield* Effect.flip(computer.screenshot),
        yield* Effect.flip(computer.snapshot(caller, {})),
        yield* Effect.flip(computer.click(caller, { target: "the Save button", ref: "@s1:e2" })),
        yield* Effect.flip(computer.key(caller, { target: "the editor", key: "a" })),
      ];
      for (const error of errors) {
        assert.equal(error.reason, "unsupported_platform");
        assert.include(error.message, "no graphical session");
      }
      assert.equal(calls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an unknown platform reports no host and names no limit", () => {
    const { layer } = harness({ platform: "freebsd", env: { DISPLAY: ":0" } });
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      assert.isUndefined((yield* computer.permissions({ automation: false })).host);
      const error = yield* Effect.flip(computer.snapshot(caller, {}));
      assert.equal(
        error.message,
        "Computer use is not available on the computer that runs T3 Code.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      name: "Wayland consent denied is a missing screenshot permission the user must answer",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      output: failure("screenshot", "PERM_DENIED", "safe"),
      reason: "screen_recording_missing",
      says: ["answer that dialog", "do not retry in a loop"],
    },
    {
      name: "Wayland consent nobody answered keeps the tool's advice and says not to loop",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      output: failure("screenshot", "TIMEOUT", "safe", "Answer the screenshot dialog."),
      reason: "failed",
      says: ["Answer the screenshot dialog.", "do not retry in a loop"],
    },
    {
      name: "an X11 compositing desktop refuses the capture with the tool's own advice",
      env: { DISPLAY: ":0" },
      output: failure("screenshot", "PLATFORM_NOT_SUPPORTED", "safe", "Capture one window."),
      reason: "failed",
      says: ["Capture one window."],
    },
  ] as const)("$name", ({ env, output, reason, says }) => {
    const { layer } = harness({ platform: "linux", env, desktop: () => output });
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const error = yield* Effect.flip(computer.screenshot);
      assert.equal(error.reason, reason);
      for (const text of says) assert.include(error.message, text);
      assert.notInclude(error.message, "Mac permissions");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a capture that is not an image is a failure, never a blank screenshot", () => {
    const { layer } = harness({ platform: "win32", png: new Uint8Array(64) });
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const error = yield* Effect.flip(computer.screenshot);
      assert.equal(error.reason, "failed");
      assert.include(error.message, "not an image");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a refused snapshot carries the tool's advice, not the Mac permission wording", () => {
    const { layer } = harness({
      platform: "linux",
      env: { DISPLAY: ":0" },
      desktop: () => failure("snapshot", "PERM_DENIED", "safe", "Start the accessibility bus."),
    });
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const error = yield* Effect.flip(computer.snapshot(caller, {}));
      assert.equal(error.reason, "accessibility_missing");
      assert.include(error.message, "Start the accessibility bus.");
      assert.notInclude(error.message, "Mac permissions");
    }).pipe(Effect.provide(layer));
  });

  it.effect("the state directory is private to the user, as agent-desktop demands on Linux", () => {
    const { desktopCalls, layer } = harness({ platform: "linux", env: { DISPLAY: ":0" } });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const computer = yield* ComputerUse.ComputerUse;
      yield* computer.snapshot(caller, {});
      const home = desktopCalls().at(-1)!.env!.AGENT_DESKTOP_HOME!;
      assert.equal((yield* fs.stat(home)).mode & 0o777, 0o700);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a failed install names no Mac fallback", () => {
    const { layer } = harness({ platform: "win32", installFails: true });
    return Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const error = yield* Effect.flip(computer.snapshot(caller, {}));
      assert.include(error.message, "could not be installed");
      assert.notInclude(error.message, "computer_screenshot");
    }).pipe(Effect.provide(layer));
  });
});
