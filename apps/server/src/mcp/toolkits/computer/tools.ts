import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ComputerUse from "../../../computerUse/ComputerUse.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Models often quote coordinates ("1200"); both forms decode to a number.
const Coordinate = Schema.Union([Schema.Number, Schema.NumberFromString]);

export const ComputerParameters = Schema.Struct({
  action: Schema.Literals(["permissions", "click", "type", "key"]),
  x: Schema.optional(Coordinate),
  y: Schema.optional(Coordinate),
  button: Schema.optional(Schema.Literals(["left", "right"])),
  double: Schema.optional(Schema.Boolean),
  text: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  modifiers: Schema.optional(Schema.Array(Schema.String)),
  clientRequestId: Schema.optional(Schema.String),
});
export type ComputerParameters = typeof ComputerParameters.Type;

export const ComputerScreenshotParameters = Schema.Struct({
  // An empty struct serializes as `anyOf [object, array]`, which some providers reject.
  includeImage: Schema.optional(
    Schema.Boolean.annotate({ description: "Set false to skip the image and get only its size." }),
  ),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ComputerUse.ComputerUse,
];

const ComputerTool = Tool.make("t3_computer", {
  description:
    "Operate the user's Mac (macOS hosts only). `permissions` reports which macOS permissions T3 Code has: screenRecording, accessibility, automation. `click` (x, y in the pixels of your latest computer_screenshot; button left|right; double), `type` (text) and `key` (key = one character or return, tab, space, escape, delete, left, right, up, down, home, end, pageup, pagedown, f1-f12; modifiers command, shift, option, control) each ask the user to approve that exact action, wait for the answer, and act only on Approve, once. Never click or type blind: take computer_screenshot first and again after each action to check the result. `approval_pending` means the user has not answered yet: call again with the same arguments to keep waiting. A denied or expired action is final: do not retry it or reach the same effect another way. A missing permission is reported, not fixable by you: tell the user to grant it in Settings > Mac permissions and stop. Repeating the same call reuses the same approval; pass a new clientRequestId only to deliberately repeat an action that already ran. Use files and the terminal for work they can do.",
  parameters: ComputerParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Operate the Mac")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description:
    "A screenshot of the Mac's main screen, as an image. Read-only and needs no approval. Pixels in this image are the x, y coordinates for t3_computer click. Take one before the first click and after each action. When Screen Recording is not granted it returns an error naming the permission instead of an image: tell the user to grant it in Settings > Mac permissions and do not retry.",
  parameters: ComputerScreenshotParameters,
  success: Schema.Struct({
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
    }),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot the Mac")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerStandardToolkit = Toolkit.make(ComputerTool);
export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);
export const ComputerToolkit = Toolkit.make(ComputerTool, ComputerScreenshotTool);
