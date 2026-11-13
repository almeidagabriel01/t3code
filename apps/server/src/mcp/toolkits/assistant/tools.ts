import {
  AssistantToolAccess,
  AUTONOMY_MODES,
  AssistantWorkspace,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as AssistantSandboxControl from "../../../assistants/AssistantSandboxControl.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as AutonomyService from "../../../autonomy/AutonomyService.ts";
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
    "container_task",
    "container_discard",
    "task_dismiss",
    "task_restore",
    "notify_user",
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
  /** create, update: a real project makes it a project assistant; leave out for the default home. group_post: the request's project. */
  projectId: Schema.optional(Text(128)),
  /** A project assistant over several projects; replaces `projectId`. */
  projectIds: Schema.optional(Schema.Array(Text(128)).check(Schema.isMaxLength(20))),
  role: Schema.optional(Text(60)),
  /** update: reply-only, or reply-and-notify to also wake on its own rules. */
  notifications: Schema.optional(Schema.Literals(AUTONOMY_MODES)),
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
  /** group_post: the complete request. container_task: the complete task. notify_user: the message. */
  text: Schema.optional(Text(20_000)),
  /** task_dismiss, task_restore: the task's thread. notify_user: the thread to link. */
  threadId: Schema.optional(Text(128)),
  /** group_post: files to share with the group (absolute paths, copied when sent). */
  paths: Schema.optional(Schema.Array(Text(1024)).check(Schema.isMaxLength(10))),
});
export type AssistantParameters = typeof AssistantParameters.Type;

const AssistantTool = Tool.make("t3_assistant", {
  description: [
    "The user's named assistants (Jarvis, others), each a long-lived thread, and their groups. Read: `list`, or `read` a `handle`: {handle, name, threadId, toolAccess, askBeforeActing, workspace (host or sandbox), icon, avatar, scope (all or project), projectIds, connectors, role, teams: [{name, members, lead}], archived, tasks: [{threadId, title, status (running, waiting, done, failed), dismissed}] (50 newest; tasksTruncated when more)}. To ask one something, t3_thread_send to its threadId and end your turn; its answer arrives later as a new message. Members of a group may message each other.",
    "Change (all take an optional `clientRequestId`; a repeat with the same one changes nothing more): `create` {name, instructions, toolAccess, workspace?, projectId? or projectIds? (the projects it may work in; refused elsewhere), role?, avatarHue?}, `update` {handle, any of those, notifications?: reply-only (answer only when messaged, the default) or reply-and-notify (also wake on its own rules); set notifications only when the user asks, in a turn they started}, `archive` {handle}, `group_create` {name, members?: handles, lead?}, `group_update` {group, name?, members? (replaces), addMembers?, removeMembers?, lead?}, `task_dismiss` / `task_restore` {threadId}: hide or show a finished task in the list (refused while it runs; the thread stays). Groups may be empty or hold one assistant; only active assistants can join. A group's optional `lead` (a member's handle) only routes a group request that mentions no one; it gives no extra permissions. `group_create` and `group_update` work only in a turn the user started; from another assistant's message, a schedule or a group task they are refused, so tell the user and do not retry. Each change leaves a line in the group chat.",
    '`notify_user` {text, threadId?, clientRequestId?}: an assistant only, when the user asked to be told ("message me when the deploy ends", "send me the summary"). Sends a short plain message to the user\'s Telegram (or iMessage) and Activity, with a link to `threadId` if given. No attachments or secrets. Refused while assistant notifications are paused or past today\'s limit: then tell the user in your reply and do not retry.',
    "`group_post` {group, text, paths?, projectId?}: post a request in a group's chat from this conversation. Write a complete brief; start it with `@handle` (or `@everyone`) to pick who works on it, otherwise the lead routes it. projectId: the project it is for (id or name, one of the members' projects); left out, the lead picks it. Members answer in the group chat, not to you. Not available inside a group task (use t3_group there).",
    '`container_task` {text, name? (title), clientRequestId?}: run ONE task in the sandbox container while you stay on this Mac ("run the CI in the container"). Only when the user asks for the container; otherwise work here. Never switch your workspace for it. The first time it asks the user how much CPU the container may use ({status: pending_decision}); if it answers pending_decision or starting, tell the user and repeat the same call later. {status: started} means end your turn: the result arrives as a message. The container is discarded when its tasks are done, unless the user keeps it. `container_discard`: remove it now (its files stay); refused while tasks run in it.',
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
    AssistantSandboxControl.AssistantSandboxControl,
    RemoteDelegation.RemoteDelegation,
    PeerForwarding.PeerForwarding,
    AssistantGroups.AssistantGroups,
    DecisionService.DecisionService,
    ManagedProjectFolders.ManagedProjectFolders,
    AutonomyService.AutonomyService,
  ],
})
  .annotate(Tool.Title, "Assistants")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AssistantToolkit = Toolkit.make(AssistantTool);
