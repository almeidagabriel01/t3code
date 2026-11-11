import { expect, it } from "@effect/vitest";
import {
  ComputerUseError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ComputerUse from "../../../computerUse/ComputerUse.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ComputerHandlers from "./handlers.ts";
import { ComputerParameters, ComputerScreenshotToolkit, ComputerStandardToolkit } from "./tools.ts";

it("a ref is an alternative to coordinates and snapshot is a known action", () => {
  const decode = Schema.decodeUnknownSync(ComputerParameters);
  expect(decode({ action: "click", ref: "@s1:e2" })).toMatchObject({ ref: "@s1:e2" });
  expect(decode({ action: "snapshot", app: "Notes", root: "@s1:e1" })).toMatchObject({
    app: "Notes",
  });
});

it("accepts coordinates as numbers or quoted numbers", () => {
  const decode = Schema.decodeUnknownSync(ComputerParameters);
  expect(decode({ action: "click", x: 12, y: "3" })).toMatchObject({ x: 12, y: 3 });
  // Not a number: the service refuses it as an invalid coordinate.
  expect(decode({ action: "click", x: "left", y: 1 }).x).toBeNaN();
});

const projectId = ProjectId.make("project-a");
const providerInstanceId = ProviderInstanceId.make("codex");

/** A PNG header is enough for the dimensions reader. */
const png = new Uint8Array(33);
new DataView(png.buffer).setUint32(0, 0x89504e47);
new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
new DataView(png.buffer).setUint32(12, 0x49484452);
new DataView(png.buffer).setUint32(16, 640);
new DataView(png.buffer).setUint32(20, 360);

const harness = (client?: "read-only") => {
  const seen: Array<readonly [string, unknown, unknown]> = [];
  const refuse = (reason: ComputerUseError["reason"]) =>
    Effect.fail(new ComputerUseError({ reason }));
  const computer = Layer.mock(ComputerUse.ComputerUse)({
    permissions: () =>
      Effect.succeed({
        supported: true,
        screenRecording: "granted",
        accessibility: "denied",
        automation: "unknown",
        host: {
          os: "linux",
          display: "wayland",
          capabilities: [{ key: "pointer", state: "unavailable", detail: "No pointer." }],
        },
      }),
    screenshot: Effect.succeed({ png, width: 640, height: 360 }),
    snapshot: (caller, input) =>
      Effect.sync(() => {
        seen.push(["snapshot", caller, input]);
        return {
          app: "Notes",
          window: null,
          complete: true,
          refCount: 1,
          truncated: true,
          nodes: [{ ref: "@s1:e2", role: "button", name: "New", actions: ["click"] }],
        };
      }),
    click: (caller, input) =>
      input.x === 99
        ? refuse("not_approved")
        : input.ref === undefined && (input.x === undefined || input.y === undefined)
          ? refuse("invalid")
          : Effect.sync(() => void seen.push(["click", caller, input])),
    type: (caller, input) => Effect.sync(() => void seen.push(["type", caller, input])),
    key: (caller, input) => Effect.sync(() => void seen.push(["key", caller, input])),
  });
  const deps = Layer.mergeAll(
    computer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "thread:test",
      thread: {
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "session",
        providerInstanceId,
      },
      client:
        client === undefined ? undefined : { sessionId: "client", label: "Client", access: client },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          projectId,
          title: "Tidy settings",
          deletedAt: null,
          archivedAt: null,
          activeRunId: "run-1",
          providerInstanceId,
          runtimeMode: "full-access",
          interactionMode: "default",
        } as unknown as OrchestrationV2ThreadShell),
    }),
  );
  return Effect.gen(function* () {
    const context = Layer.succeedContext(yield* Layer.build(deps));
    const standard = yield* ComputerStandardToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ComputerHandlers.layerStandard).pipe(
          Layer.provide(context),
        ),
      ),
    );
    const screenshot = yield* ComputerScreenshotToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ComputerHandlers.layerScreenshot).pipe(
          Layer.provide(context),
        ),
      ),
    );
    const call = (input: ComputerParameters) =>
      standard.handle("t3_computer", input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result as Record<string, any>),
        Effect.provide(context),
      );
    const shoot = screenshot.handle("computer_screenshot", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)?.result as Record<string, any>),
      Effect.provide(context),
    );
    return { call, shoot, seen };
  });
};

it.effect("passes the caller, arguments and request id through, and says what is next", () =>
  Effect.gen(function* () {
    const { call, shoot, seen } = yield* harness();
    expect(yield* call({ action: "permissions" })).toEqual({
      supported: true,
      screenRecording: "granted",
      accessibility: "denied",
      automation: "unknown",
      host: {
        os: "linux",
        display: "wayland",
        capabilities: [{ key: "pointer", state: "unavailable", detail: "No pointer." }],
      },
    });
    const clicked = yield* call({
      action: "click",
      target: "the Save button",
      x: 10,
      y: 20,
      button: "right",
      double: true,
      clientRequestId: "c1",
    });
    expect(clicked).toMatchObject({ ok: true, action: "click" });
    yield* call({ action: "type", target: "the name field", text: "hello" });
    yield* call({ action: "key", target: "the editor", key: "a", modifiers: ["command"] });
    const caller = { threadId: "thread-1", projectId, threadTitle: "Tidy settings" };
    expect(seen).toMatchObject([
      [
        "click",
        caller,
        {
          target: "the Save button",
          x: 10,
          y: 20,
          button: "right",
          double: true,
          clientRequestId: "c1",
        },
      ],
      ["type", caller, { target: "the name field", text: "hello" }],
      ["key", caller, { target: "the editor", key: "a", modifiers: ["command"] }],
    ]);
    expect(yield* shoot).toEqual({
      screenshot: { mimeType: "image/png", data: expect.any(String), width: 640, height: 360 },
    });
  }).pipe(Effect.scoped),
);

it.effect("reports a missing argument or a refused action as a failure the agent can read", () =>
  Effect.gen(function* () {
    const { call, seen } = yield* harness();
    for (const input of [
      { action: "click", target: "t", y: 1 },
      { action: "click", target: "t", x: 1 },
      { action: "type", target: "t" },
      { action: "key", target: "t" },
      { action: "click", x: 1, y: 1 },
    ] satisfies ComputerParameters[]) {
      expect(yield* call(input)).toMatchObject({ code: "invalid_request" });
    }
    const refused = yield* call({ action: "click", target: "t", x: 99, y: 1 });
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect(refused.message).toContain("did not approve");
    expect(seen).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("snapshot returns the elements and a drill-in note; click and type pass the ref", () =>
  Effect.gen(function* () {
    const { call, seen } = yield* harness();
    const shot = yield* call({ action: "snapshot", app: "Notes" });
    expect(shot).toMatchObject({ app: "Notes", nodes: [{ ref: "@s1:e2" }] });
    expect(shot.note).toContain("root");
    yield* call({ action: "click", target: "New", ref: "@s1:e2" });
    yield* call({ action: "type", target: "Search", ref: "@s1:e3", text: "hi" });
    expect(seen).toMatchObject([
      ["snapshot", {}, { app: "Notes" }],
      ["click", {}, { ref: "@s1:e2" }],
      ["type", {}, { ref: "@s1:e3", text: "hi" }],
    ]);
  }).pipe(Effect.scoped),
);

it.effect("a read-only client can snapshot and read permissions but not act", () =>
  Effect.gen(function* () {
    const { call, seen } = yield* harness("read-only");
    expect(yield* call({ action: "permissions" })).toMatchObject({
      supported: true,
      host: { display: "wayland", capabilities: [{ key: "pointer", state: "unavailable" }] },
    });
    expect(yield* call({ action: "snapshot" })).toMatchObject({ app: "Notes" });
    seen.length = 0;
    expect(yield* call({ action: "click", target: "t", x: 1, y: 1 })).toMatchObject({
      code: expect.any(String),
    });
    expect(seen).toEqual([]);
  }).pipe(Effect.scoped),
);
