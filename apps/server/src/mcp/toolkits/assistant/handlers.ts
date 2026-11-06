import { OrchestratorMcpFailure, type Assistant, type AssistantTeam } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { type AssistantParameters, AssistantToolkit } from "./tools.ts";

type Out = Record<string, Schema.Json>;

const brief = (
  assistant: Assistant,
  all: ReadonlyArray<Assistant>,
  teams: ReadonlyArray<AssistantTeam>,
): Out => ({
  assistantId: assistant.id,
  handle: assistant.handle,
  name: assistant.name,
  projectId: assistant.projectId,
  threadId: assistant.threadId,
  toolAccess: assistant.toolAccess,
  askBeforeActing: assistant.askBeforeActing,
  workspace: assistant.workspace,
  icon: assistant.icon,
  connectors: assistant.mcpServers.map(({ name, transport, enabled }) => ({
    name,
    transport,
    enabled,
  })),
  role: assistant.role,
  reportsTo: all.find((other) => other.id === assistant.reportsTo)?.handle ?? null,
  reports: all.filter((other) => other.reportsTo === assistant.id).map((other) => other.handle),
  teams: teams
    .filter((team) => team.memberIds.includes(assistant.id))
    .map((team) => ({
      name: team.name,
      members: team.memberIds.flatMap((id) => all.find((other) => other.id === id)?.handle ?? []),
      leader: all.find((other) => other.id === team.leaderId)?.handle ?? null,
      leaderTitle: team.leaderTitle,
    })),
  archived: assistant.archivedAt !== null,
});

export const run = Effect.fn("mcp.assistant.run")(function* (input: AssistantParameters) {
  const assistants = yield* AssistantService.AssistantService;
  const all = yield* assistants.list.pipe(Effect.mapError(unavailable));
  const teams = yield* assistants.teams.pipe(Effect.mapError(unavailable));
  if (input.action === "list")
    return { assistants: all.map((assistant) => brief(assistant, all, teams)) } satisfies Out;
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
  return brief(found, all, teams);
});

export const layer = McpToolAccess.toLayer(AssistantToolkit, {
  t3_assistant: McpToolAccess.reads(run),
});
