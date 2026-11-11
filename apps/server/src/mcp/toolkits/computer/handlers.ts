import { type ComputerUseError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import * as ComputerUse from "../../../computerUse/ComputerUse.ts";
import { delegationAncestors, pngDimensions } from "../device/handlers.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import {
  type ComputerParameters,
  ComputerScreenshotToolkit,
  ComputerStandardToolkit,
  ComputerToolkit,
} from "./tools.ts";

type Out = Record<string, Schema.Json>;

/** The message tells the agent what to do next; it never carries command output. */
const computerFailure = (error: ComputerUseError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const need = <T>(value: T | undefined, name: string, action: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${action} needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);

const done = (action: string): Out => ({
  ok: true,
  action,
  next: "Take a snapshot (or computer_screenshot after a coordinate click) to check the result before the next action.",
});

const run = Effect.fn("mcp.computer.run")(
  function* (input: ComputerParameters) {
    const computer = yield* ComputerUse.ComputerUse;
    if (input.action === "permissions") {
      const { host, ...permissions } = yield* computer.permissions({ automation: true });
      return {
        ...permissions,
        ...(host === undefined
          ? {}
          : {
              host: {
                os: host.os,
                ...(host.display === undefined ? {} : { display: host.display }),
                capabilities: host.capabilities.map((capability) => ({ ...capability })),
              },
            }),
      } satisfies Out;
    }
    const context = yield* loadCaller();
    const caller = {
      threadId: context.scope.thread!.threadId,
      projectId: context.caller!.projectId,
      threadTitle: context.caller!.title,
      ancestors: yield* delegationAncestors(context.caller!, context.threads.getThreadShell),
    };
    const clientRequestId = input.clientRequestId;
    if (input.action === "snapshot") {
      const result = yield* computer.snapshot(caller, { app: input.app, root: input.root });
      return {
        ...result,
        nodes: result.nodes.map((node) => ({ ...node })),
        ...(result.truncated
          ? { note: "Only the first elements are listed: pass `root` with a ref to drill in." }
          : {}),
      } satisfies Out;
    }
    const target = yield* need(input.target, "target", input.action);
    switch (input.action) {
      case "click":
        yield* computer.click(caller, {
          target,
          ref: input.ref,
          x: input.x,
          y: input.y,
          button: input.button,
          double: input.double,
          clientRequestId,
        });
        return done("click");
      case "type":
        yield* computer.type(caller, {
          target,
          ref: input.ref,
          text: yield* need(input.text, "text", "type"),
          clientRequestId,
        });
        return done("type");
      case "key":
        yield* computer.key(caller, {
          target,
          key: yield* need(input.key, "key", "key"),
          modifiers: input.modifiers,
          clientRequestId,
        });
        return done("key");
    }
  },
  Effect.catchTags({ ComputerUseError: (error) => Effect.fail(computerFailure(error)) }),
);

const handlers = {
  t3_computer: McpToolAccess.either(
    (input: ComputerParameters) => input.action === "permissions" || input.action === "snapshot",
    McpToolAccess.readsAsCaller(run),
    McpToolAccess.actsAsCaller(run),
  ),
  computer_screenshot: McpToolAccess.readsAsCaller((_input) =>
    Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const shot = yield* computer.screenshot;
      return {
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(shot.png).toString("base64"),
          ...pngDimensions(shot.png),
        },
      };
    }).pipe(Effect.mapError(computerFailure)),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerToolkit.tools>;

const { computer_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(ComputerStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot,
});
