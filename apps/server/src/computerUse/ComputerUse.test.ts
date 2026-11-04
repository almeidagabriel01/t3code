import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as DecisionService from "../decisions/DecisionService.ts";
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
}

const harness = (options: {
  readonly platform?: NodeJS.Platform;
  readonly permissions?: string;
  readonly png?: Uint8Array;
  /** A database shared by several instances, as a restarted server finds it. */
  readonly database?: Layer.Layer<SqlClient.SqlClient>;
}) => {
  const calls: Call[] = [];
  /** The mock runner is the only way anything could touch the Mac. */
  const scripted = (marker: string) => calls.filter((call) => call.args[3]?.includes(marker));
  const runner = Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            calls.push({ command: input.command, args: input.args });
            const script = input.args[3] ?? "";
            let stdout = "";
            if (script.includes("CGPreflight")) stdout = options.permissions ?? GRANTED;
            else if (script.includes("NSScreen")) stdout = "100 50\n";
            else if (script.includes("frontmost")) stdout = "System Settings\n";
            else if (input.command.endsWith("screencapture")) {
              yield* fs.writeFile(input.args.at(-1)!, options.png ?? new Uint8Array(4_096).fill(7));
            }
            return {
              stdout,
              stderr: "",
              code: 0,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            } as never;
          }).pipe(Effect.orDie),
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
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
    Layer.provideMerge(Layer.mergeAll(runner, decisions, NodeServices.layer)),
    Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
  );
  return { calls, scripted, layer };
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
});
