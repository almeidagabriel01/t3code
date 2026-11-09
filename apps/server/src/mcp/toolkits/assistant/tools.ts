import {
  AssistantToolAccess,
  AssistantWorkspace,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
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
    "group_post",
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
  /** A project assistant over several projects; replaces `projectId`. */
  projectIds: Schema.optional(Schema.Array(Text(128)).check(Schema.isMaxLength(20))),
  role: Schema.optional(Text(60)),
  /** 0-359: the color of its robot avatar. */
  avatarHue: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 359 }))),
  /** group_update: the group's name. group_create: leave it for `name`. */
  group: Schema.optional(Text(60)),
  /** group_create: the starting members (may be none). group_update: replaces the members. */
  members: Schema.optional(Schema.Array(Text(64)).check(Schema.isMaxLength(50))),
  addMembers: Schema.optional(Schema.Array(Text(64)).check(Schema.isMaxLength(50))),
  removeMembers: Schema.optional(Schema.Array(Text(64)).check(Schema.isMaxLength(50))),
  /** A member's handle, or null for no lead. */
  lead: Schema.optional(Schema.NullOr(Text(64))),
  /** group_post: the complete request. */
  text: Schema.optional(Text(20_000)),
  /** group_post: files to share with the group (absolute paths, copied when sent). */
  paths: Schema.optional(Schema.Array(Text(1024)).check(Schema.isMaxLength(10))),
});
export type AssistantParameters = typeof AssistantParameters.Type;

const AssistantTool = Tool.make("t3_assistant", {
  description: [
    "The user's named assistants (Jarvis, others), each a long-lived thread, and their groups. Read: `list`, or `read` a `handle`: {handle, name, threadId, toolAccess, askBeforeActing, workspace (host or sandbox), icon, avatar, scope (all or project), projectIds, connectors, role, teams: [{name, members, lead}], archived}. To ask one something, t3_thread_send to its threadId and end your turn; its answer arrives later as a new message. Members of a group may message each other.",
    "Change (all take an optional `clientRequestId`; a repeat with the same one changes nothing more): `create` {name, instructions, toolAccess, workspace?, projectId? or projectIds? (the projects it may work in; refused elsewhere), role?, avatarHue?}, `update` {handle, any of those}, `archive` {handle}, `group_create` {name, members?: handles, lead?}, `group_update` {group, name?, members? (replaces), addMembers?, removeMembers?, lead?}. Groups may be empty or hold one assistant; only active assistants can join. A group's optional `lead` (a member's handle) only routes a group request that mentions no one; it gives no extra permissions. `group_create` and `group_update` work only in a turn the user started; from another assistant's message, a schedule or a group task they are refused, so tell the user and do not retry. Each change leaves a line in the group chat.",
    "`group_post` {group, text, paths?}: post a request in a group's chat from this conversation. Write a complete brief; start it with `@handle` (or `@everyone`) to pick who works on it, otherwise the lead routes it. Members answer in the group chat, not to you. Not available inside a group task (use t3_group there).",
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
    AssistantGroups.AssistantGroups,
    DecisionService.DecisionService,
    ManagedProjectFolders.ManagedProjectFolders,
  ],
})
  .annotate(Tool.Title, "Assistants")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AssistantToolkit = Toolkit.make(AssistantTool);
