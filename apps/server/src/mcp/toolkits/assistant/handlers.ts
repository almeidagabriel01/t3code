import { OrchestratorMcpFailure, type Assistant } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { type AssistantParameters, AssistantToolkit } from "./tools.ts";

type Out = Record<string, Schema.Json>;

const brief = (assistant: Assistant): Out => ({
  assistantId: assistant.id,
  handle: assistant.handle,
  name: assistant.name,
  projectId: assistant.projectId,
  threadId: assistant.threadId,
  toolAccess: assistant.toolAccess,
  archived: assistant.archivedAt !== null,
});

const run = Effect.fn("mcp.assistant.run")(function* (input: AssistantParameters) {
  const assistants = yield* AssistantService.AssistantService;
  const all = yield* assistants.list.pipe(Effect.mapError(unavailable));
  if (input.action === "list") return { assistants: all.map(brief) } satisfies Out;
  const wanted = input.handle?.trim().replace(/^@/, "").toLowerCase();
  if (wanted === undefined || wanted === "") {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "read needs `handle`.",
    });
  }
  const found = all.find((assistant) => assistant.handle === wanted);
  if (found === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `No assistant has the handle "${wanted}". Use list.`,
    });
  }
  return brief(found);
});

export const layer = McpToolAccess.toLayer(AssistantToolkit, {
  t3_assistant: McpToolAccess.reads(run),
});
