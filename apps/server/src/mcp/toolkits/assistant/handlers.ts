// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hash.
import * as NodeCrypto from "node:crypto";

import {
  type Assistant,
  assistantEffectiveProjectIds,
  type AssistantEnvironmentPreference,
  type AssistantError,
  assistantIdFromThreadId,
  type AutonomyError,
  type AssistantId,
  type AssistantTeam,
  type AssistantToolAccess,
  type AssistantsUpdateInput,
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLink,
  type ProjectId,
  runtimeModeForToolAccess,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { AssistantDirectory } from "../../../assistants/AssistantDirectory.ts";
import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as AutonomyService from "../../../autonomy/AutonomyService.ts";
import * as ChannelOutbox from "../../../channels/ChannelOutbox.ts";
import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import { runtimeModeRank } from "../../delegatedTaskModes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { requireUserTurn } from "../../turnOrigin.ts";
import { containerDiscard, containerTask } from "./containerTask.ts";
import { type AssistantParameters, AssistantToolkit } from "./tools.ts";

type Out = Record<string, Schema.Json>;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** What a stored environment default can name here: this server, its stored links, or "auto". */
interface Environments {
  readonly localId: EnvironmentId;
  readonly enabled: boolean;
  readonly links: ReadonlyArray<PeerLink>;
}

/** Stored links only: reading a default never asks a peer whether it answers. */
const environments = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const links = yield* PeerLinks.PeerLinks;
  return {
    localId: scope.environmentId,
    enabled: yield* links.enabled,
    links: yield* links.stored.pipe(Effect.orElseSucceed((): ReadonlyArray<PeerLink> => [])),
  } satisfies Environments;
});

const isLocal = (preference: string, view: Environments) =>
  preference === "local" || preference === view.localId;

const environmentLabel = (preference: AssistantEnvironmentPreference, view: Environments) =>
  isLocal(preference, view)
    ? "Local"
    : preference === "auto"
      ? "Auto"
      : (view.links.find((link) => link.environmentId === preference)?.label ?? preference);

/** null: none set, so its work runs here (or, in a group's thread, on the group's default). */
const environmentOf = (
  preference: AssistantEnvironmentPreference | null | undefined,
  view: Environments,
): Schema.Json =>
  preference == null
    ? null
    : {
        value: preference,
        label: environmentLabel(preference, view),
        state: isLocal(preference, view)
          ? "ok"
          : !view.enabled
            ? "linked_environments_off"
            : preference === "auto" || view.links.some((link) => link.environmentId === preference)
              ? "ok"
              : "unavailable",
      };

/** Accepts "local", "auto", this server's id, or a link's id or label; stores the id. */
const pickEnvironment = (
  wanted: string | null | undefined,
  view: Environments,
): Effect.Effect<AssistantEnvironmentPreference | null | undefined, OrchestratorMcpFailure> => {
  if (wanted == null) return Effect.succeed(wanted);
  const trimmed = wanted.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "local" || lower === "auto") return Effect.succeed(lower);
  if (trimmed === view.localId) return Effect.succeed(view.localId);
  const byId = view.links.find((link) => link.environmentId === trimmed);
  const byLabel = view.links.filter((link) => link.label.toLowerCase() === lower);
  const link = byId ?? (byLabel.length === 1 ? byLabel[0] : undefined);
  if (link !== undefined) return Effect.succeed(link.environmentId);
  const options = [
    'Local ("local")',
    ...view.links.map((each) => `${each.label} ("${each.environmentId}")`),
    'Auto ("auto")',
  ];
  return Effect.fail(
    invalid(
      `"${trimmed}" is not this server or one of its linked environments. Use one of: ${options.join(", ")}.`,
    ),
  );
};

const brief = (
  assistant: Assistant,
  all: ReadonlyArray<Assistant>,
  teams: ReadonlyArray<AssistantTeam>,
  view: Environments,
): Out => ({
  assistantId: assistant.id,
  handle: assistant.handle,
  name: assistant.name,
  projectId: assistant.projectId,
  projectIds: [...assistant.projectIds],
  effectiveProjectIds: [...assistantEffectiveProjectIds(assistant, teams)],
  threadId: assistant.threadId,
  toolAccess: assistant.toolAccess,
  askBeforeActing: assistant.askBeforeActing ?? false,
  workspace: assistant.workspace ?? "host",
  icon: assistant.icon ?? null,
  avatar: (assistant.avatar ?? null) as Schema.Json,
  scope: assistant.scope,
  notifications: assistant.autonomy.mode,
  onProblem: assistant.autonomy.onProblem,
  connectors: assistant.mcpServers.map(({ name, transport, enabled }) => ({
    name,
    transport,
    enabled,
  })),
  integrations:
    assistant.integrations.mode === "all"
      ? { mode: "all" }
      : { mode: "selected", names: [...assistant.integrations.names] },
  role: assistant.role,
  defaultModel:
    assistant.defaultModelSelection == null
      ? null
      : {
          providerInstanceId: assistant.defaultModelSelection.instanceId,
          model: assistant.defaultModelSelection.model,
        },
  defaultEnvironment: environmentOf(assistant.defaultEnvironment, view),
  teams: teams
    .filter((team) => team.memberIds.includes(assistant.id))
    .map((team) => ({
      name: team.name,
      members: team.memberIds.flatMap((id) => all.find((other) => other.id === id)?.handle ?? []),
      lead: all.find((other) => other.id === team.leadId)?.handle ?? null,
      projectIds: [...team.projectIds],
      defaultEnvironment: environmentOf(team.defaultEnvironment, view),
    })),
  archived: assistant.archivedAt !== null,
});

const failure = (error: AssistantError) =>
  error.reason === "storage" ? unavailable() : invalid(error.message);

const notifyFailure = (error: AutonomyError) =>
  error.reason === "storage" ? unavailable() : invalid(error.message);

const rankOf = (access: AssistantToolAccess) => runtimeModeRank(runtimeModeForToolAccess(access));

const sha = (...parts: ReadonlyArray<unknown>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const find = (
  all: ReadonlyArray<Assistant>,
  handle: string | undefined,
  action: string,
): Effect.Effect<Assistant, OrchestratorMcpFailure> => {
  const wanted = handle?.trim().replace(/^@/, "").toLowerCase();
  if (wanted === undefined || wanted === "")
    return Effect.fail(invalid(`${action} needs \`handle\`.`));
  const found = all.find((assistant) => assistant.handle === wanted);
  return found === undefined
    ? Effect.fail(invalid(`No assistant has the handle "${wanted}". Use list.`))
    : Effect.succeed(found);
};

const read = Effect.fn("mcp.assistant.read")(function* (input: AssistantParameters) {
  const assistants = yield* AssistantService.AssistantService;
  const all = yield* assistants.list.pipe(Effect.mapError(unavailable));
  const teams = yield* assistants.teams.pipe(Effect.mapError(unavailable));
  const view = yield* environments;
  if (input.action === "list")
    return {
      assistants: all.map((assistant) => brief(assistant, all, teams, view)),
    } satisfies Out;
  const found = yield* find(all, input.handle, "read");
  const { tasks, truncated } = yield* assistants.tasksOf(found.id as AssistantId);
  return {
    ...brief(found, all, teams, view),
    tasks,
    ...(truncated ? { tasksTruncated: true } : {}),
  };
});

/** Only active assistants can be named; the first handle that is not one is reported. */
const resolveActive = (all: ReadonlyArray<Assistant>, handles: ReadonlyArray<string>) =>
  Effect.forEach(handles, (handle) =>
    find(all, handle, "a member").pipe(
      Effect.filterOrFail(
        (assistant) => assistant.archivedAt === null,
        () => invalid(`@${handle.replace(/^@/, "")} is archived.`),
      ),
    ),
  );

/**
 * A change above the caller's own level waits for the user. The decision is keyed by the call, so
 * the same call made again after the user answers goes through, and only that call.
 */
const approvalGate = Effect.fn("mcp.assistant.approvalGate")(function* (input: {
  readonly requestKey: string;
  readonly title: string;
  readonly context: string;
}) {
  const decisions = yield* DecisionService.DecisionService;
  const { caller } = yield* loadCaller();
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "This client has no conversation to ask the user in, so it can only make assistants up to its own level.",
    });
  }
  for (let attempt = 0; ; attempt++) {
    const decision = yield* decisions
      .request({
        fromThreadId: caller.id,
        projectId: caller.projectId,
        threadTitle: caller.title,
        clientRequestId: `assistant-access:${input.requestKey}:${attempt}`,
        title: input.title.slice(0, 120),
        context: input.context,
        options: [
          {
            id: "accept",
            label: "Approve",
            consequence: "The assistant is made or changed as asked",
          },
          { id: "deny", label: "Decline", consequence: "Nothing changes" },
        ],
        recommended: "deny",
        expiresInMinutes: 60 * 24,
      })
      .pipe(Effect.mapError(() => unavailable()));
    if (decision.status === "open") {
      return {
        status: "pending_approval",
        decisionId: decision.id,
        message:
          "This needs more access than you have, so the user was asked to approve it. Tell them it is waiting, and repeat this same call (same clientRequestId) after they approve.",
      } satisfies Out;
    }
    if (decision.status === "expired") continue;
    if (decision.status === "answered" && decision.answer?.optionId === "accept") return null;
    return yield* invalid("The user declined this change.");
  }
});

const mutate = Effect.fn("mcp.assistant.mutate")(function* (input: AssistantParameters) {
  const assistants = yield* AssistantService.AssistantService;
  const caller = yield* loadCaller();
  const callerRank = runtimeModeRank(caller.limits.runtimeMode);
  const all = yield* assistants.list.pipe(Effect.mapError(unavailable));
  const teams = yield* assistants.teams.pipe(Effect.mapError(unavailable));
  const key = `${caller.scope.requestNamespace}:${input.clientRequestId?.trim() || `auto:${sha(input)}`}`;
  const view = yield* environments;
  const show = (assistant: Assistant) => brief(assistant, all, teams, view);
  const done = (status: string, assistant: Assistant): Out => ({
    status,
    assistant: show(assistant),
  });
  const avatar =
    input.avatarHue === undefined ? undefined : ({ kind: "robot", hue: input.avatarHue } as const);
  const defaultModel =
    input.defaultModel == null
      ? input.defaultModel
      : {
          instanceId: input.defaultModel.providerInstanceId,
          model: input.defaultModel.model,
        };

  if (input.integrations !== undefined)
    return yield* invalid("Only the user can change which integrations an assistant uses");
  if (input.action === "group_create" || input.action === "group_update")
    yield* requireUserTurn(caller, "change a group");
  // Waking on its own spends the user's tokens, so only the user turns it on.
  if (
    input.action === "update" &&
    (input.notifications !== undefined || input.onProblem !== undefined)
  )
    yield* requireUserTurn(caller, "change when an assistant notifies them");
  // Projects bound a project assistant, so only the user moves that bound.
  if (
    (input.action === "update" || input.action === "create") &&
    (input.projectIds !== undefined || input.projectId !== undefined)
  )
    yield* requireUserTurn(caller, "change which projects an assistant may work in");
  // Where work runs spends the user's machines, so only the user moves it.
  if (input.action === "update" && input.defaultEnvironment !== undefined)
    yield* requireUserTurn(caller, "change where an assistant's work runs");
  const defaultEnvironment =
    input.action === "update" || input.action === "group_update"
      ? yield* pickEnvironment(input.defaultEnvironment, view)
      : undefined;
  /** One chat line per change, so a repeat of the same call adds none. */
  const announce = (team: AssistantTeam, lines: ReadonlyArray<string>) =>
    caller.caller === undefined
      ? Effect.void
      : Effect.forEach(
          lines,
          (text, index) =>
            AssistantGroups.AssistantGroups.pipe(
              Effect.flatMap((groups) =>
                groups.announce({
                  teamId: team.id,
                  callerThreadId: caller.caller!.id,
                  text,
                  clientRequestId: `change:${sha(key, index)}`,
                }),
              ),
              // The change is made; a missing chat line must not make the caller retry it.
              Effect.ignore,
            ),
          { discard: true },
        );
  const nameOf = (id: string) => all.find((other) => other.id === id)?.name ?? id;
  const listOf = (ids: ReadonlyArray<string>) => ids.map(nameOf).join(", ");
  const projectList = (ids: ReadonlyArray<string>) =>
    Effect.serviceOption(AssistantDirectory).pipe(
      Effect.flatMap((directory) =>
        Option.isSome(directory) && directory.value.projectTitles !== undefined
          ? directory.value.projectTitles(ids)
          : Effect.succeed<Readonly<Record<string, string>>>({}),
      ),
      Effect.map((titles) => ids.map((id) => titles[id] ?? id).join(", ")),
    );

  switch (input.action) {
    case "resend_undelivered": {
      const outbox = yield* ChannelOutbox.ChannelOutbox;
      const requeued = { telegram: 0, imessage: 0 };
      for (const kind of input.channel === undefined
        ? (["telegram", "imessage"] as const)
        : [input.channel]) {
        requeued[kind] = yield* outbox.resend(kind);
      }
      return { requeued } satisfies Out;
    }
    case "notify_user": {
      const self = caller.caller === undefined ? null : assistantIdFromThreadId(caller.caller.id);
      const assistant = all.find(
        (candidate) => candidate.id === self && candidate.archivedAt === null,
      );
      if (assistant === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Only an assistant can message the user this way. Tell the user in your reply instead.",
        });
      }
      if (input.text === undefined || input.text.trim() === "")
        return yield* invalid("notify_user needs `text`: the message.");
      const autonomy = yield* AutonomyService.AutonomyService;
      const result = yield* autonomy
        .notifyUser({
          assistantId: assistant.id,
          // A retry in the same turn lands on the first send; the same words in a later turn send again.
          key: `${caller.scope.requestNamespace}:${sha(
            input.clientRequestId?.trim() || [
              input.text,
              input.threadId,
              caller.caller?.activeRunId ?? caller.caller?.latestRunId,
            ],
          ).slice(0, 48)}`,
          text: input.text,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId as ThreadId }),
        })
        .pipe(Effect.mapError(notifyFailure));
      return {
        status: result.status,
        channels: [...result.channels],
        remainingToday: result.remainingToday,
      } satisfies Out;
    }
    case "container_task":
      return yield* containerTask(
        caller,
        input,
        `container:${sha(input.clientRequestId?.trim() || [input, caller.caller?.activeRunId ?? caller.caller?.latestRunId]).slice(0, 48)}`,
      );
    case "container_discard":
      return yield* containerDiscard();
    case "task_dismiss":
    case "task_restore": {
      const threadId = input.threadId?.trim();
      if (threadId === undefined || threadId === "")
        return yield* invalid(`${input.action} needs \`threadId\`.`);
      const dismissed = input.action === "task_dismiss";
      const id = threadId as ThreadId;
      const task = yield* (
        dismissed ? assistants.dismissTask(id) : assistants.restoreTask(id)
      ).pipe(Effect.mapError(failure));
      return { threadId: task.threadId, dismissed: task.dismissedAt != null } satisfies Out;
    }
    case "group_post": {
      if (caller.caller === undefined) {
        return yield* invalid("group_post needs a conversation to post from.");
      }
      if (input.group === undefined || input.group.trim() === "")
        return yield* invalid("group_post needs `group`: the group's name or id.");
      if (input.text === undefined || input.text.trim() === "")
        return yield* invalid("group_post needs `text`: the complete request.");
      const groups = yield* AssistantGroups.AssistantGroups;
      const posted = yield* groups
        .agentPost({
          callerThreadId: caller.caller.id,
          group: input.group.trim(),
          text: input.text.trim(),
          ...(input.paths === undefined ? {} : { paths: input.paths }),
          ...(input.projectId === undefined ? {} : { project: input.projectId }),
          ...(input.model === undefined
            ? {}
            : {
                modelSelection: {
                  instanceId: input.model.providerInstanceId,
                  model: input.model.model,
                },
              }),
          clientRequestId: key,
        })
        .pipe(Effect.mapError(failure));
      return {
        status: "posted",
        messageId: posted.message.id,
        tasks: posted.tasks.map((task) => ({
          taskId: task.id,
          owner: all.find((assistant) => assistant.id === task.ownerId)?.handle ?? task.ownerId,
          status: task.status,
        })),
        next: "Members answer in the group chat, not here; no reply comes back to this conversation. Tell the user to read the answer in that group's chat.",
      } satisfies Out;
    }
    case "create": {
      const toolAccess = input.toolAccess;
      if (toolAccess === undefined) {
        return yield* invalid(
          "create needs `toolAccess`. Ask the user which level to use, offering `default (up to my level)` or a custom setup, then call again.",
        );
      }
      if (input.name === undefined || input.name.trim() === "")
        return yield* invalid("create needs `name`.");
      const projectId = (input.projectIds?.[0] ??
        input.projectId ??
        (yield* (yield* ManagedProjectFolders.ManagedProjectFolders).ensureAssistantProject.pipe(
          Effect.mapError(() => unavailable()),
        )).projectId) as ProjectId;
      if (rankOf(toolAccess) > callerRank) {
        const pending = yield* approvalGate({
          requestKey: key,
          title: `Make assistant "${input.name}" with ${toolAccess} access`,
          context: `An agent asked for a new assistant with ${toolAccess} access, which is above its own. Role: ${input.role ?? "none"}.\n\n${input.instructions ?? ""}`,
        });
        if (pending !== null) return pending;
      }
      const made = yield* assistants
        .create(
          {
            name: input.name,
            projectId,
            ...(input.projectIds === undefined
              ? {}
              : { projectIds: input.projectIds as ReadonlyArray<ProjectId> }),
            instructions: input.instructions ?? "",
            toolAccess,
            ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
            ...(input.role === undefined ? {} : { role: input.role }),
            ...(avatar === undefined ? {} : { avatar }),
            // Its first conversation starts on it, and it is stored as its default.
            ...(defaultModel == null ? {} : { modelSelection: defaultModel }),
          },
          { id: `mcp-${sha(key).slice(0, 24)}` },
        )
        .pipe(Effect.mapError(failure));
      return done("created", made);
    }
    case "update":
    case "archive": {
      const target = yield* find(all, input.handle, input.action);
      if (input.action === "archive") {
        return done(
          "archived",
          yield* assistants
            .update({ assistantId: target.id, archived: true })
            .pipe(Effect.mapError(failure)),
        );
      }
      // Steering an assistant above your level is as strong as raising yours.
      const reached = rankOf(input.toolAccess ?? target.toolAccess);
      if (Math.max(reached, rankOf(target.toolAccess)) > callerRank) {
        const pending = yield* approvalGate({
          requestKey: key,
          title: `Change assistant "${target.name}" (${input.toolAccess ?? target.toolAccess} access)`,
          context: `An agent asked to change an assistant that has more access than it does. New instructions: ${input.instructions ?? "unchanged"}.`,
        });
        if (pending !== null) return pending;
      }
      const update: AssistantsUpdateInput = {
        assistantId: target.id as AssistantId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        ...(input.toolAccess === undefined ? {} : { toolAccess: input.toolAccess }),
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId as ProjectId }),
        ...(input.projectIds === undefined
          ? {}
          : { projectIds: input.projectIds as ReadonlyArray<ProjectId> }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(avatar === undefined ? {} : { avatar }),
        ...(defaultModel === undefined ? {} : { defaultModelSelection: defaultModel }),
        ...(defaultEnvironment === undefined ? {} : { defaultEnvironment }),
        // Only the mode changes; its rules, projects and channels stay as the user set them.
        ...(input.notifications === undefined && input.onProblem === undefined
          ? {}
          : {
              autonomy: {
                ...target.autonomy,
                ...(input.notifications === undefined ? {} : { mode: input.notifications }),
                ...(input.onProblem === undefined ? {} : { onProblem: input.onProblem }),
              },
            }),
      };
      return done("updated", yield* assistants.update(update).pipe(Effect.mapError(failure)));
    }
    case "group_create": {
      const name = input.name ?? input.group;
      if (name === undefined || name.trim() === "")
        return yield* invalid("group_create needs `name`.");
      const members = yield* resolveActive(all, input.members ?? []);
      const lead = input.lead == null ? null : (yield* find(all, input.lead, "lead")).id;
      const team = yield* assistants
        .createTeam(
          {
            name,
            memberIds: members.map((member) => member.id),
            leadId: lead,
          },
          { id: `mcp-${sha(key).slice(0, 24)}` },
        )
        .pipe(Effect.mapError(failure));
      yield* announce(team, [
        `created the group "${team.name}"${members.length === 0 ? "" : ` with ${listOf(team.memberIds)}`}`,
      ]);
      return { status: "created", group: teamBrief(team, all, view) };
    }
    default: {
      const wanted = input.group?.trim().toLowerCase();
      const team = teams.find(
        (candidate) => candidate.id === input.group || candidate.name.toLowerCase() === wanted,
      );
      if (team === undefined) return yield* invalid(`No group is named "${input.group ?? ""}".`);
      const joining = yield* resolveActive(all, [
        ...(input.members ?? []),
        ...(input.addMembers ?? []),
      ]);
      const leaving = new Set(
        (yield* Effect.forEach(input.removeMembers ?? [], (handle) =>
          find(all, handle, "a member"),
        )).map((member) => member.id),
      );
      const base = input.members === undefined ? [...team.memberIds] : [];
      const memberIds = [...new Set([...base, ...joining.map((member) => member.id)])].filter(
        (id) => !leaving.has(id),
      );
      const lead =
        input.lead === undefined
          ? undefined
          : input.lead === null
            ? null
            : (yield* find(all, input.lead, "lead")).id;
      const updated = yield* assistants
        .updateTeam({
          teamId: team.id,
          ...(input.name === undefined ? {} : { name: input.name }),
          memberIds,
          ...(lead === undefined ? {} : { leadId: lead }),
          ...(input.action === "group_update" && input.projectIds !== undefined
            ? { projectIds: input.projectIds as ReadonlyArray<ProjectId> }
            : {}),
          ...(input.addProjects === undefined
            ? {}
            : { addProjectIds: input.addProjects as ReadonlyArray<ProjectId> }),
          ...(input.removeProjects === undefined
            ? {}
            : { removeProjectIds: input.removeProjects as ReadonlyArray<ProjectId> }),
          ...(defaultEnvironment === undefined ? {} : { defaultEnvironment }),
        })
        .pipe(Effect.mapError(failure));
      const gained = updated.projectIds.filter((id) => !team.projectIds.includes(id));
      const lost = team.projectIds.filter((id) => !updated.projectIds.includes(id));
      const added = updated.memberIds.filter((id) => !team.memberIds.includes(id));
      const removed = team.memberIds.filter((id) => !updated.memberIds.includes(id));
      yield* announce(updated, [
        ...(updated.name === team.name ? [] : [`renamed the group to "${updated.name}"`]),
        ...(added.length === 0 ? [] : [`added ${listOf(added)}`]),
        ...(removed.length === 0 ? [] : [`removed ${listOf(removed)}`]),
        ...(gained.length === 0 ? [] : [`gave the group ${yield* projectList(gained)}`]),
        ...(lost.length === 0 ? [] : [`took ${yield* projectList(lost)} from the group`]),
        ...((updated.leadId ?? null) === (team.leadId ?? null)
          ? []
          : [
              updated.leadId === null || updated.leadId === undefined
                ? "removed the group's lead"
                : `made ${nameOf(updated.leadId)} the group's lead`,
            ]),
        // Last, so the lines above keep their request ids.
        ...((updated.defaultEnvironment ?? null) === (team.defaultEnvironment ?? null)
          ? []
          : [
              updated.defaultEnvironment == null
                ? "cleared the group's default environment"
                : `set the group's default environment to ${environmentLabel(updated.defaultEnvironment, view)}`,
            ]),
      ]);
      return { status: "updated", group: teamBrief(updated, all, view) };
    }
  }
});

const teamBrief = (
  team: AssistantTeam,
  all: ReadonlyArray<Assistant>,
  view: Environments,
): Out => ({
  groupId: team.id,
  name: team.name,
  projectIds: [...team.projectIds],
  defaultEnvironment: environmentOf(team.defaultEnvironment, view),
  members: team.memberIds.flatMap((id) => all.find((other) => other.id === id)?.handle ?? []),
  lead: all.find((other) => other.id === team.leadId)?.handle ?? null,
});

export const layer = McpToolAccess.toLayer(AssistantToolkit, {
  t3_assistant: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read",
    McpToolAccess.reads(read),
    McpToolAccess.writesWithCapability(mutate),
  ),
});
