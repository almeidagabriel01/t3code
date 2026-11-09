import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { AssistantAutonomy, DEFAULT_ASSISTANT_AUTONOMY } from "./autonomy.ts";
import { ModelSelection } from "./modelSelection.ts";
import type { RuntimeMode } from "./providerPolicy.ts";
import { InstanceBudgetStatus, ProviderBudget } from "./usage.ts";

/**
 * An assistant is a named, long-lived conversation: a row that points at its current real thread.
 * The thread's own model selection is the assistant's model; a reset starts a new generation.
 */
export const ASSISTANT_NAME_MAX_LENGTH = 60;
export const ASSISTANT_ROLE_MAX_LENGTH = 60;
export const ASSISTANT_INSTRUCTIONS_MAX_CHARS = 8_000;
export const DEFAULT_ASSISTANT_ID = "jarvis";

export const AssistantId = TrimmedNonEmptyString.pipe(Schema.brand("AssistantId"));
export type AssistantId = typeof AssistantId.Type;

const AssistantRole = TrimmedString.check(Schema.isMaxLength(ASSISTANT_ROLE_MAX_LENGTH));

/** Lowercase slug, unique per environment; channels route `@handle` to it. */
export const AssistantHandle = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/),
);
export type AssistantHandle = typeof AssistantHandle.Type;

/** A slug for `name`, or null when nothing usable remains. */
export function assistantHandleFromName(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug.length === 0 ? null : slug;
}

/**
 * Chat command names (`/name`, `[a-z0-9_]{1,32}`) for each assistant, from its handle, in list
 * order; a name another assistant already took gets `_2`, `_3`, ….
 */
export function assistantCommandNames<A extends { readonly handle: string }>(
  assistants: ReadonlyArray<A>,
): ReadonlyArray<{ readonly command: string; readonly assistant: A }> {
  const taken = new Set<string>();
  return assistants.map((assistant) => {
    const base =
      assistant.handle
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .slice(0, 32) || "assistant";
    let command = base;
    for (let n = 2; taken.has(command); n += 1) {
      const suffix = `_${n}`;
      command = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    }
    taken.add(command);
    return { command, assistant };
  });
}

/** Enforced through the thread's runtime mode and, for read-only, a read-only sandbox. */
export const AssistantToolAccess = Schema.Literals(["read-only", "workspace-write", "full"]);
export type AssistantToolAccess = typeof AssistantToolAccess.Type;

/**
 * Where its commands and file edits run. "sandbox" keeps the conversation here but runs the work
 * in the sandbox container; its own session on this machine can then only read.
 */
export const AssistantWorkspace = Schema.Literals(["host", "sandbox"]);
export type AssistantWorkspace = typeof AssistantWorkspace.Type;

export function runtimeModeForToolAccess(access: AssistantToolAccess): RuntimeMode {
  switch (access) {
    case "read-only":
      return "approval-required";
    case "workspace-write":
      return "auto-accept-edits";
    case "full":
      return "full-access";
  }
}

export const ASSISTANT_THREAD_PREFIX = "assistant:";

export function isAssistantThreadId(threadId: string): boolean {
  return threadId.startsWith(ASSISTANT_THREAD_PREFIX);
}

export function assistantThreadIdFor(assistantId: string, generation: number): ThreadId {
  return ThreadId.make(`${ASSISTANT_THREAD_PREFIX}${assistantId}:${generation}`);
}

/** The assistant id inside an assistant thread id, or null for any other thread. */
export function assistantIdFromThreadId(threadId: string): string | null {
  if (!isAssistantThreadId(threadId)) return null;
  const rest = threadId.slice(ASSISTANT_THREAD_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  return cut <= 0 ? null : rest.slice(0, cut);
}

/** The original bot icons an assistant can wear instead of its initial; paths live in client-runtime. */
export const ASSISTANT_ICON_IDS = [
  "bot",
  "visor",
  "helper",
  "analyst",
  "builder",
  "guardian",
  "scout",
  "scribe",
  "finance",
  "spark",
] as const;
export const AssistantIconId = Schema.Literals(ASSISTANT_ICON_IDS);
export type AssistantIconId = typeof AssistantIconId.Type;

export const ASSISTANT_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const ASSISTANT_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/**
 * What an assistant wears: a generated robot (hue and a small variant pick its look) or an image
 * the user uploaded, served as the `assistant-avatar` asset. `revision` only busts caches. A kind
 * from a newer writer decodes to null, which clients treat like no avatar.
 */
export const AssistantRobotAvatar = Schema.Struct({
  kind: Schema.Literal("robot"),
  hue: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 359 })),
  variant: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 }))),
});
export const AssistantAvatar = Schema.Union([
  AssistantRobotAvatar,
  Schema.Struct({ kind: Schema.Literal("image"), revision: Schema.Int }),
]);
export type AssistantAvatar = typeof AssistantAvatar.Type;

/**
 * "project" when the assistant lives in a real project: it may only launch, delegate and message
 * work there. "all" is the default home (Scratch or the managed assistants project). Server-derived.
 */
export const AssistantScope = Schema.Literals(["all", "project"]);
export type AssistantScope = typeof AssistantScope.Type;

/** Servers T3 itself injects; a connector may not shadow them. */
export const ASSISTANT_MCP_RESERVED_NAMES: ReadonlyArray<string> = ["t3-code", "t3-code-direct"];
export const ASSISTANT_MCP_MAX_SERVERS = 20;

export const AssistantMcpServerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,31}$/),
);
const McpTransport = Schema.Literals(["http", "stdio"]);
const McpKey = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));
const McpValue = Schema.String.check(Schema.isMaxLength(8_000));
const McpArgs = Schema.Array(Schema.String.check(Schema.isMaxLength(2_000))).check(
  Schema.isMaxLength(50),
);
const McpUrl = Schema.String.check(Schema.isMaxLength(2_048));
const McpCommand = Schema.String.check(Schema.isMaxLength(1_000));

/**
 * Header and env values are write-only: they live in the server secret store and reads only say
 * whether one is saved. Unknown fields from a newer writer are ignored on decode.
 */
export const AssistantMcpServer = Schema.Struct({
  name: AssistantMcpServerName,
  transport: McpTransport,
  url: Schema.optional(McpUrl),
  command: Schema.optional(McpCommand),
  args: McpArgs.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  headers: Schema.Array(Schema.Struct({ key: McpKey, hasValue: Schema.Boolean })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  env: Schema.Array(Schema.Struct({ key: McpKey, hasValue: Schema.Boolean })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type AssistantMcpServer = typeof AssistantMcpServer.Type;

/** A `value` left out keeps the saved one; an empty `value` clears it. */
const McpKeyValueInput = Schema.Struct({ key: McpKey, value: Schema.optional(McpValue) });
export const AssistantMcpServerInput = Schema.Struct({
  name: AssistantMcpServerName,
  transport: McpTransport,
  url: Schema.optional(McpUrl),
  command: Schema.optional(McpCommand),
  args: Schema.optional(McpArgs),
  headers: Schema.optional(Schema.Array(McpKeyValueInput)),
  env: Schema.optional(Schema.Array(McpKeyValueInput)),
  enabled: Schema.Boolean,
});
export type AssistantMcpServerInput = typeof AssistantMcpServerInput.Type;

/** The first reason a connector list is unusable, or null. Clients and the server share it. */
export function assistantMcpServersProblem(
  servers: ReadonlyArray<AssistantMcpServerInput>,
): string | null {
  if (servers.length > ASSISTANT_MCP_MAX_SERVERS)
    return `At most ${ASSISTANT_MCP_MAX_SERVERS} connectors.`;
  const names = new Set<string>();
  for (const server of servers) {
    if (ASSISTANT_MCP_RESERVED_NAMES.includes(server.name))
      return `"${server.name}" is reserved for T3's own tools.`;
    if (names.has(server.name)) return `Two connectors are named "${server.name}".`;
    names.add(server.name);
    if (server.transport === "http") {
      let ok = false;
      try {
        const protocol = new URL(server.url ?? "").protocol;
        ok = protocol === "http:" || protocol === "https:";
      } catch {
        // not a URL
      }
      if (!ok) return `"${server.name}" needs an http or https URL.`;
    } else if ((server.command ?? "").trim() === "") {
      return `"${server.name}" needs a command.`;
    }
    for (const rows of [server.headers ?? [], server.env ?? []]) {
      if (new Set(rows.map((row) => row.key)).size !== rows.length)
        return `"${server.name}" repeats a header or variable name.`;
    }
  }
  return null;
}

export const Assistant = Schema.Struct({
  id: AssistantId,
  handle: AssistantHandle,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_NAME_MAX_LENGTH)),
  projectId: ProjectId,
  instructions: Schema.String.check(Schema.isMaxLength(ASSISTANT_INSTRUCTIONS_MAX_CHARS)),
  toolAccess: AssistantToolAccess,
  /** Jarvis: made on first use, then archived, deleted and restored like any other. */
  isDefault: Schema.Boolean,
  /** The current conversation; null only until its first launch lands. */
  threadId: Schema.NullOr(ThreadId),
  generation: Schema.Number,
  /** Spending cap over every conversation it had; priced like provider budgets. */
  budget: Schema.NullOr(ProviderBudget).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Free text such as "CEO" or "Engineer"; empty when it has none. */
  role: AssistantRole.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Whether and how it wakes on its own; see `autonomy.ts`. */
  autonomy: AssistantAutonomy.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ASSISTANT_AUTONOMY)),
  ),
  /** It may not send into an agent conversation until the user approves that exact send. */
  askBeforeActing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  workspace: AssistantWorkspace.pipe(Schema.withDecodingDefault(Effect.succeed("host" as const))),
  /** An `AssistantIconId`, kept a plain string so an id from a newer client still decodes. */
  icon: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Null derives a robot from the handle. An `icon` set before avatars existed keeps showing until this is set. */
  avatar: Schema.NullOr(AssistantAvatar).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  scope: AssistantScope.pipe(Schema.withDecodingDefault(Effect.succeed("all" as const))),
  /** Extra MCP servers injected only into this assistant's sessions, next to T3's own. */
  mcpServers: Schema.Array(AssistantMcpServer).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Assistant = typeof Assistant.Type;

export const ASSISTANT_TEAM_NAME_MAX_LENGTH = 60;

/** What the user tells every member of a group; sent with each of their tasks. */
export const ASSISTANT_TEAM_INSTRUCTIONS_MAX_CHARS = 4_000;
export const ASSISTANT_TEAM_MEMORIES_MAX = 20;
export const ASSISTANT_TEAM_MEMORY_MAX_CHARS = 300;

export const AssistantTeamId = TrimmedNonEmptyString.pipe(Schema.brand("AssistantTeamId"));
export type AssistantTeamId = typeof AssistantTeamId.Type;

const AssistantTeamInstructions = Schema.String.check(
  Schema.isMaxLength(ASSISTANT_TEAM_INSTRUCTIONS_MAX_CHARS),
);
const AssistantTeamMemories = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_TEAM_MEMORY_MAX_CHARS)),
).check(Schema.isMaxLength(ASSISTANT_TEAM_MEMORIES_MAX));

const AssistantTeamName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ASSISTANT_TEAM_NAME_MAX_LENGTH),
);

/**
 * A group of assistants that may message each other in any direction. The optional lead only
 * routes a group request that mentions nobody; it gains no permission.
 */
/** The chat counters of a group, kept on the team so a sidebar row needs no second fetch. */
export const AssistantTeamChat = Schema.Struct({
  latestSeq: Schema.Int,
  /** The last message the user has read; unread messages are the newer ones not written by them. */
  readSeq: Schema.Int,
  unreadCount: Schema.Int,
  /** A task of the group is queued, running or waiting. */
  working: Schema.Boolean,
  /** The start of the latest member message, for a "work finished" notice. */
  preview: Schema.NullOr(Schema.String),
});
export type AssistantTeamChat = typeof AssistantTeamChat.Type;

export const AssistantTeam = Schema.Struct({
  id: AssistantTeamId,
  name: AssistantTeamName,
  memberIds: Schema.Array(AssistantId),
  leadId: Schema.NullOr(AssistantId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** An archived group keeps its chat but takes no new messages and runs no work. */
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Absent from older servers. */
  chat: Schema.optionalKey(AssistantTeamChat),
  /** Absent from older servers. */
  instructions: Schema.optionalKey(AssistantTeamInstructions),
  memories: Schema.optionalKey(AssistantTeamMemories),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AssistantTeam = typeof AssistantTeam.Type;

/** The first reason a team is unusable, or null. Clients and the server share it. */
export function assistantTeamProblem(team: {
  readonly memberIds: ReadonlyArray<string>;
  readonly leadId?: string | null | undefined;
}): string | null {
  if (new Set(team.memberIds).size !== team.memberIds.length) return "A member is listed twice.";
  const leadId = team.leadId ?? null;
  if (leadId !== null && !team.memberIds.includes(leadId))
    return "The lead must be a member of the group.";
  return null;
}

export const AssistantsSubscribeInput = Schema.Struct({});
export type AssistantsSubscribeInput = typeof AssistantsSubscribeInput.Type;

/** The first event is a snapshot of every assistant, archived ones included. */
export const AssistantsEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    assistants: Schema.Array(Assistant),
    teams: Schema.Array(AssistantTeam).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  Schema.Struct({ type: Schema.Literal("upserted"), assistant: Assistant }),
  Schema.Struct({ type: Schema.Literal("removed"), assistantId: AssistantId }),
  Schema.Struct({ type: Schema.Literal("teamUpserted"), team: AssistantTeam }),
  Schema.Struct({ type: Schema.Literal("teamRemoved"), teamId: AssistantTeamId }),
]);
export type AssistantsEvent = typeof AssistantsEvent.Type;

export const AssistantsCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_NAME_MAX_LENGTH)),
  /** Derived from the name when absent. */
  handle: Schema.optional(AssistantHandle),
  projectId: ProjectId,
  /** The default new-thread model when absent. */
  modelSelection: Schema.optional(ModelSelection),
  instructions: Schema.String.check(Schema.isMaxLength(ASSISTANT_INSTRUCTIONS_MAX_CHARS)),
  toolAccess: AssistantToolAccess,
  budget: Schema.optional(Schema.NullOr(ProviderBudget)),
  autonomy: Schema.optional(AssistantAutonomy),
  askBeforeActing: Schema.optional(Schema.Boolean),
  workspace: Schema.optional(AssistantWorkspace),
  icon: Schema.optional(Schema.NullOr(AssistantIconId)),
  /** A robot only: an image goes through `assistants.setAvatarImage`. */
  avatar: Schema.optional(Schema.NullOr(AssistantRobotAvatar)),
  mcpServers: Schema.optional(Schema.Array(AssistantMcpServerInput)),
  role: Schema.optional(AssistantRole),
  /** Brings Jarvis back (recreated or unarchived) and ignores every other field. */
  restoreDefault: Schema.optional(Schema.Boolean),
});
export type AssistantsCreateInput = typeof AssistantsCreateInput.Type;

/** The other fields are placeholders: the server only reads `restoreDefault`. */
export const ASSISTANTS_RESTORE_DEFAULT_INPUT: AssistantsCreateInput = {
  name: TrimmedNonEmptyString.make("Jarvis"),
  projectId: ProjectId.make("restore-default"),
  instructions: "",
  toolAccess: "full",
  restoreDefault: true,
};

/** Changing `projectId` starts a new generation: a thread can't move between projects. */
export const AssistantsUpdateInput = Schema.Struct({
  assistantId: AssistantId,
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_NAME_MAX_LENGTH))),
  handle: Schema.optional(AssistantHandle),
  projectId: Schema.optional(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ASSISTANT_INSTRUCTIONS_MAX_CHARS)),
  ),
  toolAccess: Schema.optional(AssistantToolAccess),
  /** Null removes the cap. */
  budget: Schema.optional(Schema.NullOr(ProviderBudget)),
  autonomy: Schema.optional(AssistantAutonomy),
  askBeforeActing: Schema.optional(Schema.Boolean),
  workspace: Schema.optional(AssistantWorkspace),
  /** Null goes back to the initial. */
  icon: Schema.optional(Schema.NullOr(AssistantIconId)),
  /** A robot only; null clears the avatar (and an uploaded image). Images go through `assistants.setAvatarImage`. */
  avatar: Schema.optional(Schema.NullOr(AssistantRobotAvatar)),
  /** Replaces the whole list; leave out to keep it. */
  mcpServers: Schema.optional(Schema.Array(AssistantMcpServerInput)),
  role: Schema.optional(AssistantRole),
  archived: Schema.optional(Schema.Boolean),
});
export type AssistantsUpdateInput = typeof AssistantsUpdateInput.Type;

/**
 * The sandbox container assistants may work in. "failed" covers a build, start or link that did
 * not finish; `error` says why and Start tries again.
 */
export const AssistantSandboxState = Schema.Literals([
  "not_created",
  "starting",
  "running",
  "stopped",
  "docker_unavailable",
  "failed",
]);
export type AssistantSandboxState = typeof AssistantSandboxState.Type;

export const AssistantSandboxStatus = Schema.Struct({
  state: AssistantSandboxState,
  /** What a start is doing now; null when nothing is in progress. */
  step: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  /** The sandbox as a linked environment here; null until it is linked. */
  environmentId: Schema.NullOr(EnvironmentId),
  /** Where its T3 server answers on this machine, for signing in to its providers; null unless running. */
  url: Schema.NullOr(Schema.String),
  /** Linked environments (Settings → Labs) must be on here for the sandbox link; Start turns it on. */
  linkedEnvironmentsEnabled: Schema.Boolean,
});
export type AssistantSandboxStatus = typeof AssistantSandboxStatus.Type;

export const AssistantSandboxSubscribeInput = Schema.Struct({});
export type AssistantSandboxSubscribeInput = typeof AssistantSandboxSubscribeInput.Type;
export const AssistantSandboxStartInput = Schema.Struct({});
export type AssistantSandboxStartInput = typeof AssistantSandboxStartInput.Type;
export const AssistantSandboxStopInput = Schema.Struct({});
export type AssistantSandboxStopInput = typeof AssistantSandboxStopInput.Type;
export const AssistantSandboxRemoveInput = Schema.Struct({
  /** Also deletes the sandbox's own home and workspace files, including provider sign-ins. */
  deleteVolumes: Schema.Boolean,
});
export type AssistantSandboxRemoveInput = typeof AssistantSandboxRemoveInput.Type;

export const AssistantSandboxPairingInput = Schema.Struct({});
export type AssistantSandboxPairingInput = typeof AssistantSandboxPairingInput.Type;
/** A one-time link that connects a client on this machine to the sandbox, to sign in to its providers. */
export const AssistantSandboxPairing = Schema.Struct({ pairingUrl: Schema.String });
export type AssistantSandboxPairing = typeof AssistantSandboxPairing.Type;

/**
 * Upload the image first with `attachments.createUploadUrl` (png, jpeg or webp, up to
 * `ASSISTANT_AVATAR_MAX_BYTES`); the server checks its bytes, keeps its own copy and returns the
 * assistant with an image avatar. Clear it with `assistants.update { avatar: null }`.
 */
export const AssistantsSetAvatarImageInput = Schema.Struct({
  assistantId: AssistantId,
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type AssistantsSetAvatarImageInput = typeof AssistantsSetAvatarImageInput.Type;

export const AssistantsDeleteInput = Schema.Struct({ assistantId: AssistantId });
export type AssistantsDeleteInput = typeof AssistantsDeleteInput.Type;

/** A fresh conversation, or `restoreThreadId` to bring back one of this assistant's old ones. */
export const AssistantsResetInput = Schema.Struct({
  assistantId: AssistantId,
  restoreThreadId: Schema.optional(ThreadId),
});
export type AssistantsResetInput = typeof AssistantsResetInput.Type;

export const AssistantsSpendInput = Schema.Struct({ assistantId: AssistantId });
export type AssistantsSpendInput = typeof AssistantsSpendInput.Type;

/** Estimated at API prices from T3's own turns, across every conversation the assistant had. */
export const AssistantSpend = Schema.Struct({
  todayUsd: Schema.Number,
  /** Rolling last 30 days, including today. */
  periodUsd: Schema.Number,
  /** Some turns had no usage or no known rate, so the totals are a floor. */
  partial: Schema.Boolean,
  budget: Schema.optionalKey(InstanceBudgetStatus),
});
export type AssistantSpend = typeof AssistantSpend.Type;

export const AssistantTeamsCreateInput = Schema.Struct({
  name: AssistantTeamName,
  memberIds: Schema.Array(AssistantId),
  leadId: Schema.optional(Schema.NullOr(AssistantId)),
});
export type AssistantTeamsCreateInput = typeof AssistantTeamsCreateInput.Type;

/** A field left out is kept; `leadId: null` removes the lead. */
export const AssistantTeamsUpdateInput = Schema.Struct({
  teamId: AssistantTeamId,
  name: Schema.optional(AssistantTeamName),
  memberIds: Schema.optional(Schema.Array(AssistantId)),
  leadId: Schema.optional(Schema.NullOr(AssistantId)),
  /** true archives the group and stops its work; false restores it. */
  archived: Schema.optional(Schema.Boolean),
  instructions: Schema.optional(AssistantTeamInstructions),
  /** Replaces the whole list. */
  memories: Schema.optional(AssistantTeamMemories),
});
export type AssistantTeamsUpdateInput = typeof AssistantTeamsUpdateInput.Type;

export const AssistantTeamsDeleteInput = Schema.Struct({ teamId: AssistantTeamId });
export type AssistantTeamsDeleteInput = typeof AssistantTeamsDeleteInput.Type;
export const AssistantTeamsDeleteResult = Schema.Struct({ teamId: AssistantTeamId });
export type AssistantTeamsDeleteResult = typeof AssistantTeamsDeleteResult.Type;

export const AssistantsDeleteResult = Schema.Struct({ assistantId: AssistantId });
export type AssistantsDeleteResult = typeof AssistantsDeleteResult.Type;

export class AssistantError extends Schema.TaggedError<AssistantError>()("AssistantError", {
  reason: Schema.Literals([
    "not_found",
    "handle_taken",
    "invalid",
    "storage",
    // A group message that names no member, in a group whose lead cannot route it.
    "mention_required",
    "archived",
  ]),
  message: Schema.String,
}) {}
