import {
  OrchestratorMcpFailure,
  DeviceToolCloseInput,
  DeviceToolError,
  DeviceToolListResult,
  DeviceToolOpenInput,
  DeviceToolOpenResult,
  DeviceToolScreenshotResult,
  DeviceToolTargetInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../../../config.ts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as HeavyQueue from "../../../heavyQueue/HeavyQueue.ts";
import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  DeviceService.DeviceService,
  // A device set to "ask first" asks the thread's user through a decision.
  DecisionService.DecisionService,
];

const DeviceToolFailure = Schema.Union([DeviceToolError, OrchestratorMcpFailure]);

const DeviceListTool = Tool.make("device_list", {
  description:
    'List iOS Simulators, Android Emulators and connected physical devices (`physical: true`; `issues` name what only the user can fix first) on every device host, what each host can run, what is open in this thread\'s Device panel, and `heldByUser`: devices the user is driving by hand. Call before `device_open` when you do not know a device id. A host with `kind: "linked"` is another T3 Code environment linked to this one, whose owner can refuse; if its `linkState` is not `connected`, tell the user its `linkDetail` instead of retrying.',
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    hostId: Schema.optional(
      Schema.String.annotate({ description: "Limit to one device host. Defaults to all hosts." }),
    ),
  }),
  success: DeviceToolListResult,
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List devices")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeviceOpenTool = Tool.make("device_open", {
  description:
    "Open a simulator, emulator or physical device for this thread. Pass `deviceId` and `hostId` from `device_list`. Boots a simulator or emulator if needed (a physical device must already be on) and shows it in the user's Device panel. Returns the `agent-device` CLI call pinned to that device. Drive the device with that CLI. The user decides which devices agents may use: an error saying access is denied, still waiting for the user, or that the user is holding the device is final for now. Wait or use another device; never reach the device another way (adb, simctl, idb, ssh), and do not retry in a loop.",
  parameters: Schema.Struct({
    ...DeviceToolOpenInput.fields,
    skipHeavyQueue: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Set only when the user chose to run now despite an overloaded machine or a heavy-work queue. Default: wait for the queue's turn when others are queued.",
      }),
    ),
  }),
  success: DeviceToolOpenResult,
  failure: DeviceToolFailure,
  dependencies: [
    ...dependencies,
    FileSystem.FileSystem,
    Path.Path,
    ServerConfig.ServerConfig,
    // The thread's project can name the EAS project a cloud device runs under.
    ProjectService.ProjectService,
    HeavyQueue.HeavyQueue,
  ],
})
  .annotate(Tool.Title, "Open device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceScreenshotTool = Tool.make("device_screenshot", {
  description:
    "Get a PNG of an open device's screen. Works while the user is holding the device. For taps and text, use the `agent-device` CLI.",
  parameters: DeviceToolTargetInput,
  success: DeviceToolScreenshotResult,
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot device")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const DeviceCloseTool = Tool.make("device_close", {
  description:
    "Remove a device from this thread's Device panel. `shutdown=true` also turns a simulator or emulator off; a physical device stays on. Refused while the user is holding the device.",
  parameters: DeviceToolCloseInput,
  success: Schema.Record(Schema.String, Schema.Never),
  failure: DeviceToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Close device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceStandardToolkit = Toolkit.make(DeviceListTool, DeviceOpenTool, DeviceCloseTool);

export const DeviceScreenshotToolkit = Toolkit.make(DeviceScreenshotTool);

export const DeviceToolkit = Toolkit.make(
  DeviceListTool,
  DeviceOpenTool,
  DeviceScreenshotTool,
  DeviceCloseTool,
);
