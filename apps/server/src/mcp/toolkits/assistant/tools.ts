import {
  AssistantToolAccess,
  AssistantWorkspace,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const AssistantParameters = Schema.Struct({
  action: Schema.Literals([
    "list",
    "read",
    "create",
    "update",
    "archive",
    "group_create",
    "group_update",
  ]),
  /** read, update, archive: the assistant. */
  handle: Schema.optional(Text(64)),
  /** Mutating actions: a repeat with the same id changes nothing more. */
  clientRequestId: Schema.optional(Text(128)),
  /** create, update. */
  name: Schema.optional(Text(60)),
  instructions: Schema.optional(Text(8_000)),
  /** create: required. update: leave out to keep it. */
  toolAccess: Schema.optional(AssistantToolAccess),
  workspace: Schema.optional(AssistantWorkspace),
  /** A real project makes it a project assistant; leave out for the default home. */
  projectId: Schema.optional(Text(128)),
  role: Schema.optional(Text(60)),
  /** A handle, or null for top-level. */
  reportsTo: Schema.optional(Schema.NullOr(Text(64))),
  /** 0-359: the color of its robot avatar. */
  avatarHue: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 359 }))),
  /** group_update: the group's name. group_create: leave it for `name`. */
  group: Schema.optional(Text(60)),
  /** group_create: the starting members (may be none). group_update: replaces the members. */
  members: Schema.optional(Schema.Array(Text(64)).check(Schema.isMaxLength(50))),
  addMembers: Schema.optional(Schema.Array(Text(64)).check(Schema.isMaxLength(50))),
  removeMembers: Schema.optional(Schema.Array(Text(64)).check(Schema.isMaxLength(50))),
  /** A member's handle, or null for no leader. */
  leader: Schema.optional(Schema.NullOr(Text(64))),
  leaderTitle: Schema.optional(Schema.NullOr(Text(60))),
});
export type AssistantParameters = typeof AssistantParameters.Type;

const AssistantTool = Tool.make("t3_assistant", {
  description: [
    "The user's named assistants (Jarvis, others), each a long-lived thread, and their groups. Read: `list`, or `read` a `handle`: {handle, name, threadId, toolAccess, askBeforeActing, workspace (host or sandbox), icon, avatar, scope (all or project), connectors, role, reportsTo, reports, teams: [{name, members, leader, leaderTitle}], archived}. To ask one something, t3_thread_send to its threadId, then t3_thread_wait. Members of a group may message each other.",
    "Change (all take an optional `clientRequestId`; a repeat with the same one changes nothing more): `create` {name, instructions, toolAccess, workspace?, projectId?, role?, reportsTo?, avatarHue?}, `update` {handle, any of those}, `archive` {handle}, `group_create` {name, members?: handles, leader?, leaderTitle?}, `group_update` {group, name?, members? (replaces), addMembers?, removeMembers?, leader?, leaderTitle?}. Groups may be empty or hold one assistant; only active assistants can join.",
    'toolAccess is read-only, workspace-write or full, and is the user\'s call: on `create` it is required. If the user did not say which, ask them first and offer `default (up to my level)` or a custom setup; never pick it yourself and do not call create until they answer. Default means your own level, or the closest one below it. A level above yours (or changing an assistant that is above yours) is not made right away: the user gets an approval card and the result is {status: "pending_approval"}. Tell the user it is waiting, then repeat the same call (same clientRequestId) once they approve.',
  ].join(" "),
  parameters: AssistantParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AssistantService.AssistantService,
    DecisionService.DecisionService,
    ManagedProjectFolders.ManagedProjectFolders,
  ],
})
  .annotate(Tool.Title, "Assistants")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AssistantToolkit = Toolkit.make(AssistantTool);
