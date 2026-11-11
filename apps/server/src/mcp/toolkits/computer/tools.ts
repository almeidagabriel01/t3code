import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ComputerUse from "../../../computerUse/ComputerUse.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Models often quote coordinates ("1200"); both forms decode to a number.
const Coordinate = Schema.Union([Schema.Number, Schema.NumberFromString]);

export const ComputerParameters = Schema.Struct({
  action: Schema.Literals(["permissions", "snapshot", "click", "type", "key"]),
  target: Schema.optional(
    Schema.String.annotate({
      description:
        "Required for click, type and key: what you are acting on, shown to the user in the approval, e.g. 'the blue Save button in System Settings > Privacy'.",
    }),
  ),
  app: Schema.optional(
    Schema.String.annotate({
      description: "snapshot: the app's name, e.g. 'Safari'. Omit for the app in front.",
    }),
  ),
  ref: Schema.optional(
    Schema.String.annotate({
      description:
        "click and type: an element ref from snapshot, like '@s26u7pv9qta5g4:e6'. Use it instead of x and y.",
    }),
  ),
  root: Schema.optional(
    Schema.String.annotate({
      description: "snapshot: a ref whose subtree to list, to drill into a dense app.",
    }),
  ),
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
    "Operate the computer T3 Code runs on (macOS, Windows or Linux). `permissions` reports what works there: on macOS the permissions screenRecording, accessibility, automation; on Windows and Linux `host`, each capability with its limit. Prefer `snapshot` for any app's UI: it is read-only, needs no approval, and lists the app's interactive elements (role, name, ref); `app` names the app, `root` is a ref to drill into. Then `click` and `type` take that `ref` instead of x, y, which is exact and works without moving the mouse. A ref goes stale when the app changes: snapshot again. Only when snapshot finds no usable element (apps without an accessibility tree, canvases) fall back to computer_screenshot and `click` with x, y in its pixels (button left|right; double). `type` (text; with `ref` it types into that element, without it into whatever is focused) and `key` (key = one character or return, tab, space, escape, delete, left, right, up, down, home, end, pageup, pagedown, f1-f12; modifiers command, shift, option, control) complete the set. click, type and key each need `target`, a short plain description of what you are acting on (\"the blue Save button in System Settings > Privacy\"), and each ask the user to approve that exact action: the user sees target, the element or coordinates or text, and the app in front, so be specific and honest. They wait for the answer and act only on Approve, once. Check the result after each action with snapshot (or computer_screenshot for coordinate clicks). `approval_pending` means the user has not answered yet: call again with the same arguments to keep waiting. A denied or expired action is final: do not retry it or reach the same effect another way. A missing permission is reported, not fixable by you: tell the user to grant it in Settings > Mac permissions and stop. Windows and Linux: `type` needs a `ref`; keys are one character or return, tab, space, escape, delete, left, right, up, down, f1-f12; use control, not command, for shortcuts. Linux Wayland has no x, y clicks, and Linux screenshots can be refused, so work by snapshot refs there. An error naming a limit of the host is final: tell the user and stop. Repeating the same call reuses the same approval; pass a new clientRequestId only to deliberately repeat an action that already ran. Use files and the terminal for work they can do.",
  parameters: ComputerParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Operate the computer")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description:
    "A screenshot of the main screen of the computer T3 Code runs on, as an image. Read-only and needs no approval. Pixels in this image are the x, y coordinates for t3_computer click. Take one before the first click and after each action. When Screen Recording is not granted it returns an error naming the permission instead of an image: tell the user to grant it in Settings > Mac permissions and do not retry. On Linux it can be refused (Wayland asks the user to allow it, some X11 desktops cannot capture the screen): report the error and use t3_computer snapshot.",
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
  .annotate(Tool.Title, "Screenshot the computer")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerStandardToolkit = Toolkit.make(ComputerTool);
export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);
export const ComputerToolkit = Toolkit.make(ComputerTool, ComputerScreenshotTool);
