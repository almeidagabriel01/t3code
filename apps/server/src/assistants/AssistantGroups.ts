// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hash.
import * as NodeCrypto from "node:crypto";

import {
  ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION,
  ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY,
  ASSISTANT_GROUP_PAGE_SIZE,
  ASSISTANT_GROUP_PARALLEL_LIMIT,
  ASSISTANT_GROUP_REPLY_LIMIT,
  ASSISTANT_GROUP_REPLY_MAX_CHARS,
  AssistantError,
  AssistantGroupMessageId,
  AssistantGroupTaskId,
  type AssistantGroupMessage,
  type AssistantGroupTask,
  type AssistantGroupTaskKind,
  type AssistantGroupTaskStatus,
  type AssistantGroupsEvent,
  type AssistantGroupsConversationInput,
  type AssistantGroupsConversationResult,
  type AssistantGroupsHistoryInput,
  type AssistantGroupsHistoryResult,
  type AssistantGroupsMarkReadInput,
  type AssistantGroupsMarkReadResult,
  type AssistantGroupsPostInput,
  type AssistantGroupsPostResult,
  type AssistantGroupsTaskActionInput,
  type AssistantId,
  type AssistantsEvent,
  type AssistantTeam,
  type AssistantTeamId,
  assistantGroupAddress,
  assistantGroupProjectIds,
  assistantGroupProjectMentions,
  assistantIdFromThreadId,
  ChatAttachment,
  ChatAttachmentId,
  CommandId,
  isAssistantGroupThreadId,
  TextGenerationError,
  type ModelSelection,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectId,
  type ServerSettings as ServerSettingsValue,
  type RunId,
  runtimeModeForToolAccess,
  ThreadId,
  type DecisionId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  createDeterministicAttachmentId,
  parseAttachmentFileExtension,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as AttachmentClaims from "../orchestration-v2/AttachmentClaims.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectModelSelection from "../orchestration-v2/ProjectModelSelectionService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import { continuesAtReset } from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { AssistantGroupGate } from "./AssistantGroupGate.ts";
import { routeGroupMessage } from "./AssistantGroupRouting.ts";
import { threadsWaitingOnUser, type ThreadWait } from "./AssistantGroupWaiting.ts";
import { firstConflict, normalizeResources } from "./AssistantGroupResources.ts";
import {
  childResultsText,
  groupTaskPacket,
  handOverText,
  PACKET_SUMMARY_CHARS,
  type PacketMember,
} from "./AssistantGroupPacket.ts";
import { AssistantService } from "./AssistantService.ts";
import { AssistantDirectory, type AssistantRow, toAssistant } from "./AssistantDirectory.ts";
import {
  assistantProjects,
  assistantWorksIn,
  projectScopeRefusal,
} from "./AssistantSandboxPolicy.ts";
import {
  type AssistantTeamRow,
  decodeModelSelectionJson,
  encodeModelSelectionJson,
  toAssistantTeam,
} from "./AssistantTeams.ts";
import { copyTransfer, transferText } from "./AssistantTransfers.ts";

/** Who writes a group message: the user, an agent in another conversation, or a schedule. */
export type GroupAuthor =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly assistantId: AssistantId | null; readonly label: string }
  | { readonly kind: "routine"; readonly label: string };

export interface GroupToolResult {
  readonly accepted: boolean;
  readonly message: string;
}

export const REPLY_LIMIT_MESSAGE = "Reply limit reached; do not mention this to anyone.";
const NO_REPLY_NOTE = "No reply needed";
const UNROUTED_NOTICE = "Nobody got this message. Mention a member with @ to send it again.";
export const MENTION_REQUIRED_MESSAGE = "Mention a member with @, or set a lead that can route.";
const NO_ANSWER = "(no answer)";
/** Why a hand-off was refused: what the chat says, and what the member that asked is told. */
export const HANDOFF_PAUSES = {
  no_delivery: {
    notice: `Paused · ${ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY} hand-offs without a delivery`,
    refusal: `This request made ${ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY} hand-offs without anyone delivering a result, so the group paused it and the user decides how it goes on. Do not retry; end your turn.`,
  },
  handoff_limit: {
    notice: `Paused · ${ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION} hand-offs since your last action`,
    refusal: `This request made ${ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION} hand-offs since the user last acted on it, so the group paused it and the user decides how it goes on. Do not retry; end your turn.`,
  },
} as const;
const REPLY_TASK_REFUSAL = "This task only answers a question. Use t3_group result.";
const RESULT_WAITS_FOR_REPLY =
  "You asked a teammate a question and it is not answered yet. Wait for the answer, then post your result.";

const HISTORY_PAGE_CHARS = 24_000;
const HISTORY_MESSAGE_CHARS = 16_000;
const RESULT_MAX_CHARS = 20_000;
const ROUTING_HISTORY_MESSAGES = 10;
/** What one summary call reads of the new messages, newest first. */
const SUMMARY_INPUT_CHARS = 24_000;
const SUMMARY_MESSAGE_CHARS = 2_000;
/** Most older messages a task's #seq mentions pull into its packet. */
const QUOTED_MESSAGES = 8;
const EXPECTED_RESULT_CHARS = 500;
const CANCEL_REASON_CHARS = 300;
/** Stopped tasks a packet lists, and the instruction text kept for each. */
const STOPPED_LISTED = 5;
const STOPPED_INSTRUCTION_CHARS = 120;

/** Waiting for a slot, a run or a provider limit, or running: work the owner is still on. */
const ACTIVE: ReadonlyArray<AssistantGroupTaskStatus> = [
  "queued",
  "running",
  "waiting",
  "usage_limited",
];
/** Everything the user can still act on. */
const OPEN_NOW: ReadonlySet<string> = new Set(ACTIVE);
const OPEN: ReadonlyArray<AssistantGroupTaskStatus> = [...ACTIVE, "paused", "failed"];
const SETTLED: ReadonlyArray<AssistantGroupTaskStatus> = ["completed", "cancelled", "failed"];
/** A request whose tasks all ended this way is done; a failed one still waits on the user. */
const DELIVERED: ReadonlySet<string> = new Set(["completed", "cancelled"]);
const STOPPED_ROOT: ReadonlyArray<AssistantGroupTaskStatus> = ["paused", "failed", "cancelled"];
const ENDED_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Projects whose own default model or per-assistant models differ between two settings. */
export const projectModelChanges = (
  previous: Pick<ServerSettingsValue, "projectSettingsOverrides">,
  next: Pick<ServerSettingsValue, "projectSettingsOverrides">,
): ReadonlyArray<ProjectId> => {
  const key = (settings: typeof previous, projectId: string) => {
    const project = settings.projectSettingsOverrides[projectId as ProjectId];
    return JSON.stringify([project?.defaultModelSelection, project?.assistantModelSelections]);
  };
  return [
    ...new Set([
      ...Object.keys(previous.projectSettingsOverrides),
      ...Object.keys(next.projectSettingsOverrides),
    ]),
  ].filter((projectId) => key(previous, projectId) !== key(next, projectId)) as ProjectId[];
};
const LIVE_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"] as const;
const ACTIVE_RUN_STATUSES = ["preparing", "starting", "running", "waiting"] as const;

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

/** The member's hidden thread for a group. Look the group up in the table: team ids may hold ':'. */
export const groupThreadId = (assistantId: string, teamId: string) =>
  ThreadId.make(`assistant:${assistantId}:g-${sha256(teamId).slice(0, 16)}`);

/** A deleted thread keeps its id reserved, so its replacement derives a new one from it. */
const nextGroupThreadId = (assistantId: string, teamId: string, dead: string) =>
  ThreadId.make(`assistant:${assistantId}:g-${sha256(`${teamId}\n${dead}`).slice(0, 16)}`);

/** The member's hidden thread for one request; the same shape, so it reads as a group thread. */
export const requestThreadId = (assistantId: string, teamId: string, requestId: string) =>
  ThreadId.make(
    `assistant:${assistantId}:g-${sha256(`${teamId}\nrequest:${requestId}`).slice(0, 16)}`,
  );

const TITLE_CHARS = 80;
/** A request's title until the lead names it: its first line, without the @mentions it opens with. */
const titleFromText = (text: string) => {
  const line =
    text
      .split("\n")
      .find((candidate) => candidate.trim() !== "")
      ?.trim() ?? "";
  return clip(line.replace(/^(?:@\S+[\s,]+)+/u, "") || line, TITLE_CHARS);
};

export const taskMessageId = (taskId: string, revision: number) =>
  `group-task:${taskId}:${revision}`;

/** A run that continues a usage-limited one: at the reset, or after a provider switch. */
const isLimitContinuation = (
  run: Pick<OrchestrationV2Run, "userMessageId" | "usageLimitContinuationOfRunId">,
) =>
  run.usageLimitContinuationOfRunId !== undefined ||
  run.userMessageId.startsWith("limit-continuation:");

const parseTaskMessageId = (messageId: string) => {
  if (!messageId.startsWith("group-task:")) return null;
  const rest = messageId.slice("group-task:".length);
  const cut = rest.lastIndexOf(":");
  const revision = Number(rest.slice(cut + 1));
  return cut <= 0 || !Number.isInteger(revision) ? null : { taskId: rest.slice(0, cut), revision };
};

interface MessageRow {
  readonly message_id: string;
  readonly team_id: string;
  readonly seq: number;
  readonly author: string;
  readonly assistant_id: string | null;
  readonly author_label: string | null;
  readonly kind: string;
  readonly text: string;
  readonly reply_to: string | null;
  readonly task_id: string | null;
  readonly client_request_id: string | null;
  readonly attachments_json: string;
  readonly request_id: string | null;
  readonly project_id: string | null;
  readonly title: string | null;
  readonly wait_key: string | null;
  readonly wait_thread_id: string | null;
  readonly wait_decision_id: string | null;
  readonly wait_resolved_at: string | null;
  readonly asks_project: number;
  readonly created_at: string;
}

interface TaskRow {
  readonly task_id: string;
  readonly team_id: string;
  readonly root_id: string;
  readonly parent_id: string | null;
  readonly kind: string;
  readonly request_message_id: string;
  readonly owner_id: string;
  readonly instruction: string;
  readonly status: string;
  readonly reason: string | null;
  readonly revision: number;
  readonly result_text: string | null;
  /** Root only: hand-offs since the user last acted on the request. */
  readonly hops: number;
  /** Root only: hand-offs since a task of the request last delivered a result. */
  readonly undelivered_hops: number;
  readonly followup: string | null;
  readonly expected_result: string | null;
  readonly source_seqs_json: string;
  readonly resources_json: string;
  readonly request_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ThreadRow {
  readonly team_id: string;
  readonly assistant_id: string;
  readonly thread_id: string;
  readonly seen_seq: number;
  /** Set for a request's thread; null for the member's older thread for the whole group. */
  readonly request_id: string | null;
  readonly followed_model_selection?: string | null;
  readonly pending_model_selection?: string | null;
}

const EMPTY_MESSAGE = { attachments_json: "[]" } as MessageRow;
const AttachmentsJson = Schema.fromJsonString(Schema.Array(ChatAttachment));
const decodeAttachments = Schema.decodeUnknownOption(AttachmentsJson);
const encodeAttachments = Schema.encodeSync(AttachmentsJson);
const attachmentsOf = (row: MessageRow): ReadonlyArray<ChatAttachment> =>
  Option.getOrElse(decodeAttachments(row.attachments_json), () => []);

const toMessage = (row: MessageRow): AssistantGroupMessage => ({
  id: row.message_id as AssistantGroupMessageId,
  teamId: row.team_id as AssistantTeamId,
  seq: row.seq,
  author: row.author as AssistantGroupMessage["author"],
  assistantId: row.assistant_id as AssistantId | null,
  authorLabel: row.author_label,
  kind: row.kind as AssistantGroupMessage["kind"],
  text: row.text,
  replyToMessageId: row.reply_to as AssistantGroupMessageId | null,
  taskId: row.task_id as AssistantGroupTaskId | null,
  ...(attachmentsOf(row).length === 0 ? {} : { attachments: attachmentsOf(row) }),
  ...(row.request_id === null ? {} : { requestId: row.request_id as AssistantGroupMessageId }),
  ...(row.request_id !== row.message_id
    ? {}
    : {
        ...(row.project_id === null ? {} : { projectId: row.project_id as ProjectId }),
        title: row.title ?? titleFromText(row.text),
      }),
  ...(row.wait_thread_id === null
    ? {}
    : {
        waiting: {
          threadId: row.wait_thread_id as ThreadId,
          ...(row.wait_decision_id === null
            ? {}
            : { decisionId: row.wait_decision_id as DecisionId }),
          resolved: row.wait_resolved_at !== null,
        },
      }),
  ...(row.asks_project === 1 ? { asksProject: true } : {}),
  createdAt: row.created_at,
});

const NumbersJson = Schema.fromJsonString(Schema.Array(Schema.Int));
const StringsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeNumbers = Schema.decodeUnknownOption(NumbersJson);
const decodeStrings = Schema.decodeUnknownOption(StringsJson);
const encodeNumbers = Schema.encodeSync(NumbersJson);
const encodeStrings = Schema.encodeSync(StringsJson);
const sourceSeqsOf = (row: TaskRow) =>
  Option.getOrElse(decodeNumbers(row.source_seqs_json), () => []);
const resourcesOf = (row: TaskRow) => Option.getOrElse(decodeStrings(row.resources_json), () => []);

const toTask = (row: TaskRow, threadId: ThreadId): AssistantGroupTask => ({
  id: row.task_id as AssistantGroupTaskId,
  teamId: row.team_id as AssistantTeamId,
  rootId: row.root_id as AssistantGroupTaskId,
  parentId: row.parent_id as AssistantGroupTaskId | null,
  kind: row.kind as AssistantGroupTaskKind,
  requestMessageId: row.request_message_id as AssistantGroupMessageId,
  ownerId: row.owner_id as AssistantId,
  instruction: row.instruction,
  status: row.status as AssistantGroupTaskStatus,
  // A usage-limited task keeps its limit's reset time in `reason`.
  ...(row.status === "usage_limited"
    ? { reason: null, ...(row.reason === null ? {} : { resetAt: row.reason }) }
    : { reason: row.reason }),
  threadId,
  ...(row.request_id === null ? {} : { requestId: row.request_id as AssistantGroupMessageId }),
  ...(row.expected_result === null ? {} : { expectedResult: row.expected_result }),
  ...(sourceSeqsOf(row).length === 0 ? {} : { sourceSeqs: sourceSeqsOf(row) }),
  ...(resourcesOf(row).length === 0 ? {} : { resources: resourcesOf(row) }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const assistantError = (reason: AssistantError["reason"], message: string) =>
  new AssistantError({ reason, message });
const invalid = (message: string) => Effect.fail(assistantError("invalid", message));

const clip = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
};

const joinNames = (names: ReadonlyArray<string>, conjunction = "and") =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;

/** A request without a project (from before requests had one) runs in the member's home. */
const worksIn = (member: AssistantRow, team: AssistantTeam, projectId: string | null) =>
  projectId === null || assistantWorksIn(toAssistant(member), team, projectId as ProjectId);

/** The notice when members a message named or the lead picked cannot work in its project. */
const outsideProjectText = (
  left: ReadonlyArray<AssistantRow>,
  project: string,
  reached: ReadonlyArray<AssistantRow>,
) =>
  `${joinNames(left.map((row) => row.name))} cannot work in ${project}, so ${
    reached.length === 0
      ? "nobody got this. Send it again mentioning a member who works there."
      : `only ${joinNames(reached.map((row) => row.name))} got this.`
  }`;

export class AssistantGroups extends Context.Service<
  AssistantGroups,
  {
    /** The newest page with its tasks, then every change to this group. */
    readonly subscribe: (
      teamId: AssistantTeamId,
    ) => Stream.Stream<AssistantGroupsEvent, AssistantError>;
    readonly history: (
      input: AssistantGroupsHistoryInput,
    ) => Effect.Effect<AssistantGroupsHistoryResult, AssistantError>;
    readonly post: (
      input: AssistantGroupsPostInput,
      author: GroupAuthor,
    ) => Effect.Effect<AssistantGroupsPostResult, AssistantError>;
    readonly taskAction: (
      input: AssistantGroupsTaskActionInput,
    ) => Effect.Effect<AssistantGroupTask, AssistantError>;
    /** Moves the read position, clamped to the chat's newest message. */
    readonly markRead: (
      input: AssistantGroupsMarkReadInput,
    ) => Effect.Effect<AssistantGroupsMarkReadResult, AssistantError>;
    /** Draws a boundary, compacts, removes the latest boundary or clears the chat. */
    readonly conversation: (
      input: AssistantGroupsConversationInput,
    ) => Effect.Effect<AssistantGroupsConversationResult, AssistantError>;
    /** A post from a conversation that is not in the group: an assistant's or any agent's. */
    readonly agentPost: (input: {
      readonly callerThreadId: ThreadId;
      /** The group's id or name. */
      readonly group: string;
      readonly text: string;
      readonly paths?: ReadonlyArray<string>;
      readonly clientRequestId?: string;
      /** The request's project, by id or name, among the group's; absent lets the lead decide. */
      readonly project?: string;
    }) => Effect.Effect<AssistantGroupsPostResult, AssistantError>;
    /** The chat line an agent's change to the group leaves: "<who> <text>". A repeat adds none. */
    readonly announce: (input: {
      readonly teamId: AssistantTeamId;
      readonly callerThreadId: ThreadId;
      readonly text: string;
      readonly clientRequestId: string;
    }) => Effect.Effect<void, AssistantError>;
    /** The chat line a routine's change leaves, from the schedule itself. A repeat adds none. */
    readonly announceRoutine: (input: {
      readonly teamId: AssistantTeamId;
      readonly label: string;
      readonly text: string;
      readonly clientRequestId: string;
    }) => Effect.Effect<void, AssistantError>;
    /** What a member's tools do, keyed by the member's own group thread. */
    readonly member: {
      readonly history: (input: {
        readonly callerThreadId: ThreadId;
        readonly beforeSeq?: number;
      }) => Effect.Effect<
        { readonly messages: ReadonlyArray<AssistantGroupMessage>; readonly hasMore: boolean },
        AssistantError
      >;
      readonly assign: (input: {
        readonly callerThreadId: ThreadId;
        readonly member: string;
        readonly instruction: string;
        readonly expectedResult?: string;
        readonly sourceSeqs?: ReadonlyArray<number>;
        readonly resources?: ReadonlyArray<string>;
      }) => Effect.Effect<
        { readonly taskId: AssistantGroupTaskId; readonly status: AssistantGroupTaskStatus },
        AssistantError
      >;
      readonly transfer: (input: {
        readonly callerThreadId: ThreadId;
        readonly member: string;
        readonly note: string;
      }) => Effect.Effect<
        { readonly taskId: AssistantGroupTaskId; readonly status: AssistantGroupTaskStatus },
        AssistantError
      >;
      readonly reply: (input: {
        readonly callerThreadId: ThreadId;
        /** The member message by id, or by its number in the chat (`seq`). */
        readonly messageId?: string;
        readonly seq?: number;
        readonly text: string;
      }) => Effect.Effect<GroupToolResult, AssistantError>;
      readonly result: (input: {
        readonly callerThreadId: ThreadId;
        readonly text: string;
      }) => Effect.Effect<GroupToolResult, AssistantError>;
      /** Cancels a task the caller gave (and what that task gave on), stopping its runs. */
      readonly cancel: (input: {
        readonly callerThreadId: ThreadId;
        readonly taskId: string;
        readonly reason: string;
      }) => Effect.Effect<GroupToolResult, AssistantError>;
      /** The caller's group, and whether the request its task came from was written by the user. */
      readonly routineScope: (input: {
        readonly callerThreadId: ThreadId;
      }) => Effect.Effect<
        { readonly teamId: AssistantTeamId; readonly askedByUser: boolean },
        AssistantError
      >;
    };
    /**
     * Posts or resolves the notices of what a request's member conversations wait on the user for;
     * a no-op for a thread that is no request's.
     */
    readonly syncWaitingThread: (threadId: ThreadId) => Effect.Effect<void>;
    /** A member's run on a group thread ended or changed; moves its task along. */
    readonly handleRunEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Team and assistant changes: members leaving, groups archived or deleted. */
    readonly handleAssistantEvent: (event: AssistantsEvent) => Effect.Effect<void>;
    /** Brings group state in line with the teams now stored, for changes made while down. */
    readonly reconcile: Effect.Effect<void>;
    /**
     * These projects' default or per-assistant model changed: their open requests' threads that
     * still run on the model the project gave them move to the one it gives now.
     */
    readonly followProjectModels: (projectIds: ReadonlyArray<ProjectId>) => Effect.Effect<void>;
    /** Watches the assistants stream for the changes above. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once every background routing call has finished. */
    readonly idle: Effect.Effect<void>;
  }
>()("t3/assistants/AssistantGroups") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const assistants = yield* AssistantService;
  const modelSelections = yield* ProjectModelSelection.ProjectModelSelectionService;
  const directory = yield* AssistantDirectory;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const textGeneration = yield* TextGeneration;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const documents = yield* DocumentText.DocumentText;
  const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const lock = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<{
    readonly teamId: string;
    readonly event: AssistantGroupsEvent;
  }>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  const routing = yield* FiberSet.make<void, never>();
  /** Groups being summarized now. */
  const summarizing = new Set<string>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storage = <A, R>(self: Effect.Effect<A, SqlError | AssistantError, R>) =>
    self.pipe(
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.logWarning("assistant groups storage failed", { cause }).pipe(
            Effect.andThen(
              Effect.fail(assistantError("storage", "Could not read or write the group chat.")),
            ),
          ),
      }),
    );
  /** Background work reports its failure in the log: nobody is waiting on it. */
  const quietly =
    (what: string) =>
    <E>(self: Effect.Effect<void, E>) =>
      self.pipe(
        Effect.catchCause((cause) => Effect.logWarning(`assistant groups: ${what}`, { cause })),
      );

  /**
   * Tasks as clients see them, each with the thread its owner works it in: the request's thread,
   * else the older thread for the whole group (work from before requests had their own).
   */
  const wireTasks = Effect.fn("AssistantGroups.wireTasks")(function* (
    tasks: ReadonlyArray<TaskRow>,
  ) {
    const teams = [...new Set(tasks.map((task) => task.team_id))];
    const requests = [...new Set(tasks.flatMap((task) => task.request_id ?? []))];
    const legacy =
      teams.length === 0
        ? []
        : yield* sql<ThreadRow>`
            SELECT * FROM assistant_group_threads WHERE team_id IN ${sql.in(teams)}`;
    const own =
      requests.length === 0
        ? []
        : yield* sql<ThreadRow>`
            SELECT * FROM assistant_group_request_threads WHERE request_id IN ${sql.in(requests)}`;
    return tasks.map((task) =>
      toTask(
        task,
        (own.find((row) => row.request_id === task.request_id && row.assistant_id === task.owner_id)
          ?.thread_id ??
          legacy.find((row) => row.team_id === task.team_id && row.assistant_id === task.owner_id)
            ?.thread_id ??
          (task.request_id === null
            ? groupThreadId(task.owner_id, task.team_id)
            : requestThreadId(task.owner_id, task.team_id, task.request_id))) as ThreadId,
      ),
    );
  });

  /** The member thread a run happened in: a request's, or the older one for the whole group. */
  const threadRowOf = Effect.fn("AssistantGroups.threadRowOf")(function* (threadId: string) {
    const rows = yield* sql<ThreadRow>`
      SELECT team_id, assistant_id, thread_id, seen_seq, request_id
      FROM assistant_group_request_threads WHERE thread_id = ${threadId}
      UNION ALL
      SELECT team_id, assistant_id, thread_id, seen_seq, NULL AS request_id
      FROM assistant_group_threads WHERE thread_id = ${threadId}`;
    return rows[0];
  });

  const newId = (prefix: string) =>
    random.uuidV4().pipe(
      Effect.orDie,
      Effect.map((id) => `${prefix}:${id}`),
    );

  const teamRow = Effect.fn("AssistantGroups.teamRow")(function* (teamId: string) {
    const rows =
      yield* sql<AssistantTeamRow>`SELECT * FROM assistant_teams WHERE team_id = ${teamId}`;
    return rows[0] ?? (yield* assistantError("not_found", "Group not found."));
  });
  const loadTeam = (teamId: string) => teamRow(teamId).pipe(Effect.map(toAssistantTeam));
  /** The newest boundary's seq: what members see starts after it. 0 when there is none. */
  const boundaryOf = (teamId: string) =>
    sql<{ readonly seq: number | null }>`
      SELECT MAX(seq) AS seq FROM assistant_group_messages
      WHERE team_id = ${teamId} AND kind = 'boundary'`.pipe(
      Effect.map((rows) => rows[0]?.seq ?? 0),
    );

  const assistantRows = (ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed<ReadonlyArray<AssistantRow>>([])
      : sql<AssistantRow>`SELECT * FROM assistants WHERE assistant_id IN ${sql.in(ids)}`;

  /** The team's members that can take work, in the team's order. */
  const activeMembers = Effect.fn("AssistantGroups.activeMembers")(function* (team: AssistantTeam) {
    const rows = yield* assistantRows(team.memberIds);
    return team.memberIds.flatMap((id) => {
      const row = rows.find((candidate) => candidate.assistant_id === id);
      return row === undefined || row.archived_at !== null ? [] : [row];
    });
  });

  const nameOf = Effect.fn("AssistantGroups.nameOf")(function* (assistantId: string) {
    const rows = yield* assistantRows([assistantId]);
    return rows[0]?.name ?? "A teammate";
  });

  const getTask = Effect.fn("AssistantGroups.getTask")(function* (taskId: string) {
    const rows = yield* sql<TaskRow>`SELECT * FROM assistant_group_tasks WHERE task_id = ${taskId}`;
    return rows[0];
  });
  const requireTask = (taskId: string) =>
    getTask(taskId).pipe(
      Effect.filterOrFail(
        (task) => task !== undefined,
        () => assistantError("not_found", "Task not found."),
      ),
    );

  const getMessage = Effect.fn("AssistantGroups.getMessage")(function* (messageId: string) {
    const rows =
      yield* sql<MessageRow>`SELECT * FROM assistant_group_messages WHERE message_id = ${messageId}`;
    return rows[0];
  });

  const tasksOfMessage = (messageId: string) =>
    sql<TaskRow>`SELECT * FROM assistant_group_tasks
      WHERE request_message_id = ${messageId} AND kind = 'root' ORDER BY rowid ASC`;

  const unsettledChildren = (parentId: string) =>
    sql<TaskRow>`SELECT * FROM assistant_group_tasks
      WHERE parent_id = ${parentId} AND status NOT IN ${sql.in(SETTLED)}`;

  /**
   * The task a member is working on: the one its live run carries, which still names the member
   * after a hand-over, else the oldest it was handed that is still running.
   */
  const runningTaskOf = Effect.fn("AssistantGroups.runningTaskOf")(function* (row: ThreadRow) {
    const live = yield* engine
      .getThreadRecords(row.thread_id as ThreadId, ["runs"], {
        runStatuses: [...ACTIVE_RUN_STATUSES],
      })
      .pipe(Effect.orElseSucceed(() => ({ runs: [] })));
    for (const run of live.runs) {
      const key = parseTaskMessageId(run.userMessageId);
      const task = key === null ? undefined : yield* getTask(key.taskId);
      if (
        task?.status === "running" &&
        task.revision === key?.revision &&
        task.team_id === row.team_id
      ) {
        return task;
      }
    }
    // A request's thread only ever runs that request's tasks.
    const owned = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks
      WHERE team_id = ${row.team_id} AND owner_id = ${row.assistant_id} AND status = 'running'
        AND (${row.request_id} IS NULL OR request_id = ${row.request_id})
      ORDER BY updated_at ASC, rowid ASC LIMIT 1`;
    return owned[0];
  });

  /** A page of the chat, oldest first, with the tasks it shows. */
  const readPage = Effect.fn("AssistantGroups.readPage")(function* (
    teamId: string,
    beforeSeq: number | undefined,
  ) {
    const rows = yield* sql<MessageRow>`
      SELECT * FROM assistant_group_messages
      WHERE team_id = ${teamId} AND seq < ${beforeSeq ?? Number.MAX_SAFE_INTEGER}
      ORDER BY seq DESC LIMIT ${ASSISTANT_GROUP_PAGE_SIZE + 1}`;
    const page = rows.slice(0, ASSISTANT_GROUP_PAGE_SIZE).toReversed();
    const shownTasks = page.flatMap((row) => (row.task_id === null ? [] : [row.task_id]));
    const shownRequests = page.map((row) => row.message_id);
    const tasks = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks
      WHERE team_id = ${teamId} AND (
        status IN ${sql.in(OPEN)}
        OR task_id IN ${sql.in(shownTasks.length === 0 ? [""] : shownTasks)}
        OR request_message_id IN ${sql.in(shownRequests.length === 0 ? [""] : shownRequests)}
      ) ORDER BY rowid ASC`;
    // A request whose first message lies on an older page still needs its header and project.
    const onPage = new Set(page.map((row) => row.message_id));
    const missing = [...new Set([...page, ...tasks].flatMap((row) => row.request_id ?? []))].filter(
      (id) => !onPage.has(id),
    );
    const requests =
      missing.length === 0
        ? []
        : yield* sql<MessageRow>`
            SELECT * FROM assistant_group_messages WHERE message_id IN ${sql.in(missing)}
            ORDER BY seq ASC`;
    return {
      messages: page.map(toMessage),
      tasks: yield* wireTasks(tasks),
      hasMore: rows.length > ASSISTANT_GROUP_PAGE_SIZE,
      ...(requests.length === 0 ? {} : { requests: requests.map(toMessage) }),
    };
  });

  const publishMessage = (row: MessageRow) =>
    PubSub.publish(events, {
      teamId: row.team_id,
      event: { type: "message", message: toMessage(row) },
    });
  const publishTask = (row: TaskRow) =>
    wireTasks([row]).pipe(
      Effect.flatMap(([task]) =>
        PubSub.publish(events, { teamId: row.team_id, event: { type: "task", task: task! } }),
      ),
    );

  const insertMessage = Effect.fn("AssistantGroups.insertMessage")(function* (input: {
    readonly teamId: string;
    readonly author: AssistantGroupMessage["author"];
    readonly assistantId?: string | null;
    readonly authorLabel?: string | null;
    readonly kind: AssistantGroupMessage["kind"];
    readonly text: string;
    readonly replyTo?: string | null;
    readonly taskId?: string | null;
    readonly clientRequestId?: string | null;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    /** The request it belongs to; `new` starts one with this message; absent for chat-wide lines. */
    readonly requestId?: string | null;
    /** A new request's project and title. */
    readonly projectId?: string | null;
    readonly title?: string | null;
    /** A notice that a member's conversation waits on the user. */
    readonly wait?: ThreadWait;
    /** The lead's notice asking which project the request is for. */
    readonly asksProject?: boolean;
  }) {
    const id = yield* newId("gm");
    const requestId = input.requestId === "new" ? id : (input.requestId ?? null);
    // The next number is read in the same statement that takes it.
    const rows = yield* sql<MessageRow>`
      INSERT INTO assistant_group_messages (
        message_id, team_id, seq, author, assistant_id, author_label, kind, text, reply_to,
        task_id, client_request_id, attachments_json, request_id, project_id, title, wait_key,
        wait_thread_id, wait_decision_id, asks_project, created_at
      )
      SELECT ${id}, ${input.teamId}, COALESCE(MAX(seq), 0) + 1, ${input.author},
        ${input.assistantId ?? null}, ${input.authorLabel ?? null}, ${input.kind}, ${input.text},
        ${input.replyTo ?? null}, ${input.taskId ?? null}, ${input.clientRequestId ?? null},
        ${encodeAttachments(input.attachments ?? [])}, ${requestId}, ${input.projectId ?? null},
        ${input.title ?? null}, ${input.wait?.key ?? null}, ${input.wait?.threadId ?? null},
        ${input.wait?.decisionId ?? null}, ${input.asksProject === true ? 1 : 0}, ${yield* nowIso}
      FROM assistant_group_messages WHERE team_id = ${input.teamId}
      RETURNING *`;
    yield* publishMessage(rows[0]!);
    yield* assistants.refreshTeamChat(input.teamId);
    return rows[0]!;
  });

  const insertTask = Effect.fn("AssistantGroups.insertTask")(function* (input: {
    readonly teamId: string;
    readonly rootId?: string;
    readonly parentId?: string | null;
    readonly kind: AssistantGroupTaskKind;
    readonly requestMessageId: string;
    readonly ownerId: string;
    readonly instruction: string;
    readonly status: AssistantGroupTaskStatus;
    readonly reason?: string | null;
    readonly followup?: string | null;
    readonly expectedResult?: string | null;
    readonly sourceSeqs?: ReadonlyArray<number>;
    readonly resources?: ReadonlyArray<string>;
    readonly requestId: string | null;
  }) {
    const id = yield* newId("gt");
    const now = yield* nowIso;
    const rows = yield* sql<TaskRow>`
      INSERT INTO assistant_group_tasks (
        task_id, team_id, root_id, parent_id, kind, request_message_id, owner_id, instruction,
        status, reason, revision, hops, followup, expected_result, source_seqs_json, resources_json,
        request_id, created_at, updated_at
      ) VALUES (
        ${id}, ${input.teamId}, ${input.rootId ?? id}, ${input.parentId ?? null}, ${input.kind},
        ${input.requestMessageId}, ${input.ownerId}, ${input.instruction}, ${input.status},
        ${input.reason ?? null}, 1, 0, ${input.followup ?? null}, ${input.expectedResult ?? null},
        ${encodeNumbers(input.sourceSeqs ?? [])}, ${encodeStrings(input.resources ?? [])},
        ${input.requestId}, ${now}, ${now}
      ) RETURNING *`;
    if (OPEN.includes(input.status)) yield* reopenRequest(input.requestId);
    yield* publishTask(rows[0]!);
    yield* assistants.refreshTeamChat(input.teamId);
    return rows[0]!;
  });

  type TaskPatch = Partial<
    Pick<TaskRow, "status" | "reason" | "revision" | "owner_id" | "result_text" | "followup">
  >;
  const patchTask = Effect.fn("AssistantGroups.patchTask")(function* (
    task: TaskRow,
    patch: TaskPatch,
  ) {
    const next = { ...task, ...patch };
    const rows = yield* sql<TaskRow>`
      UPDATE assistant_group_tasks SET status = ${next.status}, reason = ${next.reason},
        revision = ${next.revision}, owner_id = ${next.owner_id}, result_text = ${next.result_text},
        followup = ${next.followup}, updated_at = ${yield* nowIso}
      WHERE task_id = ${task.task_id} RETURNING *`;
    yield* publishTask(rows[0]!);
    if (OPEN_NOW.has(task.status) !== OPEN_NOW.has(next.status)) {
      yield* assistants.refreshTeamChat(task.team_id);
    }
    const wasOpen = OPEN.includes(task.status as AssistantGroupTaskStatus);
    const isOpen = OPEN.includes(next.status as AssistantGroupTaskStatus);
    if (wasOpen && !isOpen) yield* closeRequestIfDone(task.request_id);
    if (!wasOpen && isOpen) yield* reopenRequest(task.request_id);
    return rows[0]!;
  });

  const inspectThread = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }) => thread),
      Effect.orElseSucceed(() => undefined),
    );

  const dispatchLifecycle = (
    commandId: string,
    command: "thread.archive" | "thread.unarchive" | "thread.delete",
    threadId: ThreadId,
  ) =>
    engine.dispatch({ type: command, commandId: CommandId.make(commandId), threadId }).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("assistant groups: thread change failed", { threadId, command, cause }),
      ),
    );

  /** Ends the run that carries this task's current revision, if one is still live. */
  const stopRun = Effect.fn("AssistantGroups.stopRun")(function* (task: TaskRow) {
    const threadId = (yield* wireTasks([task]))[0]!.threadId;
    const live = yield* engine
      .getThreadRecords(threadId, ["runs"], { runStatuses: [...LIVE_RUN_STATUSES] })
      .pipe(Effect.orElseSucceed(() => ({ runs: [] })));
    const run = live.runs.find(
      (candidate) => candidate.userMessageId === taskMessageId(task.task_id, task.revision),
    );
    if (run === undefined) return;
    const commandId = `group-stop:${task.task_id}:${task.revision}`;
    yield* (
      run.status === "queued"
        ? engine.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(commandId),
            threadId,
            runId: run.id,
          })
        : engine.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(commandId),
            threadId,
            runId: run.id,
            reason: "Stopped from the group",
          })
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("assistant groups: could not stop a run", {
          taskId: task.task_id,
          cause,
        }),
      ),
    );
  });

  /** Ends a task's live run, or disarms the continuation a usage-limited one waits for. */
  const haltTask = Effect.fn("AssistantGroups.haltTask")(function* (task: TaskRow) {
    if (task.status === "running") return yield* stopRun(task);
    if (task.status !== "usage_limited") return;
    const threadId = (yield* wireTasks([task]))[0]!.threadId;
    yield* engine
      .dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`group-stop:${task.task_id}:${task.revision}`),
        threadId,
        reason: "Stopped from the group",
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant groups: could not stop a limited thread", {
            taskId: task.task_id,
            cause,
          }),
        ),
      );
  });

  /** Pauses a task that is in flight, ending its run first. */
  const pauseTask = Effect.fn("AssistantGroups.pauseTask")(function* (
    task: TaskRow,
    reason: string,
  ) {
    if (!ACTIVE.includes(task.status as AssistantGroupTaskStatus)) return task;
    yield* haltTask(task);
    return yield* patchTask(task, { status: "paused", reason });
  });

  /**
   * The member's thread for a request, launched in the request's project the first time one of its
   * tasks starts, and reused by every later task of that member in the request (a reviewer handing
   * work back lands in the same conversation). A request that ended archived it; work coming back
   * restores it.
   */
  const ensureRequestThread = Effect.fn("AssistantGroups.ensureRequestThread")(function* (
    team: AssistantTeam,
    member: AssistantRow,
    request: MessageRow,
  ) {
    const rows = yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_request_threads
      WHERE request_id = ${request.message_id} AND assistant_id = ${member.assistant_id}`;
    const stored = rows[0]?.thread_id;
    let threadId = (stored ??
      requestThreadId(member.assistant_id, team.id, request.message_id)) as ThreadId;
    let thread = yield* inspectThread(threadId);
    while (thread !== undefined && thread.deletedAt !== null) {
      threadId = nextGroupThreadId(member.assistant_id, team.id, threadId);
      thread = yield* inspectThread(threadId);
    }
    const projectId = (thread?.projectId ?? request.project_id ?? member.project_id) as ProjectId;
    if (!assistantWorksIn(toAssistant(member), team, projectId)) {
      return yield* invalid(`${member.name} cannot work in this request's project.`);
    }
    let followed: ModelSelection | null = null;
    if (thread === undefined) {
      const { selection: modelSelection } = yield* modelSelections
        .resolveForNewThread({
          projectId,
          assistantId: member.assistant_id as AssistantId,
          teamId: team.id,
        })
        .pipe(
          Effect.mapError(() =>
            assistantError("storage", "Could not work out the model for this request."),
          ),
        );
      yield* launches
        .launch({
          // A launch's receipt may outlive its thread (rows copied without their threads), so a
          // relaunch of a stored thread uses another id.
          commandId: CommandId.make(
            `${stored === undefined ? "assistant-group-launch" : "assistant-group-relaunch"}:${threadId}`,
          ),
          threadId,
          projectId,
          title: `${member.name} · ${team.name} · ${clip(request.title ?? titleFromText(request.text), 60)}`,
          generateTitle: false,
          modelSelection,
          runtimeMode: runtimeModeForToolAccess(toAssistant(member).toolAccess),
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(() =>
            assistantError("storage", "Could not start the member's thread for this request."),
          ),
        );
      followed = modelSelection;
    }
    // A new thread has seen none of the request.
    yield* sql`
      INSERT INTO assistant_group_request_threads
        (request_id, assistant_id, team_id, thread_id, seen_seq, followed_model_selection)
      VALUES (${request.message_id}, ${member.assistant_id}, ${team.id}, ${threadId}, 0,
        ${encodeModelSelectionJson(followed)})
      ON CONFLICT (request_id, assistant_id) DO UPDATE
      SET thread_id = excluded.thread_id, seen_seq = 0,
        followed_model_selection = excluded.followed_model_selection, pending_model_selection = NULL
      WHERE thread_id <> excluded.thread_id OR ${thread === undefined ? 1 : 0}`;
    // A finished request archived it, or the member left and came back.
    if (thread !== undefined && thread.archivedAt !== null) {
      yield* dispatchLifecycle(
        `assistant-group-unarchive:${threadId}:${yield* newId("u")}`,
        "thread.unarchive",
        threadId,
      );
    }
    return { threadId, projectId };
  });

  const requestThreads = (requestId: string) =>
    sql<ThreadRow>`SELECT * FROM assistant_group_request_threads WHERE request_id = ${requestId}`;

  /**
   * Moves a request thread to `target` while it still runs on the model the project gave it; a
   * change made in the thread wins. A thread mid-turn refuses another provider, so the move waits
   * for the turn to end (`applyPendingModel`).
   */
  const followModel = Effect.fn("AssistantGroups.followModel")(function* (
    row: ThreadRow,
    target: ModelSelection,
  ) {
    const followed = decodeModelSelectionJson(row.followed_model_selection);
    const thread = yield* inspectThread(row.thread_id as ThreadId);
    const follows =
      followed !== null &&
      thread !== undefined &&
      thread.deletedAt === null &&
      modelSelectionsEqual(thread.modelSelection, followed);
    if (!follows || modelSelectionsEqual(target, followed)) {
      yield* sql`UPDATE assistant_group_request_threads SET pending_model_selection = NULL
        WHERE thread_id = ${row.thread_id}`;
      return;
    }
    const switched = yield* engine
      .dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`assistant-group-model:${row.thread_id}:${yield* newId("m")}`),
        threadId: row.thread_id as ThreadId,
        modelSelection: target,
      })
      .pipe(Effect.result);
    if (switched._tag === "Success") {
      yield* sql`UPDATE assistant_group_request_threads
        SET followed_model_selection = ${encodeModelSelectionJson(target)},
          pending_model_selection = NULL
        WHERE thread_id = ${row.thread_id}`;
    } else if (switched.failure._tag === "OrchestratorProviderSelectionBusyError") {
      yield* sql`UPDATE assistant_group_request_threads
        SET pending_model_selection = ${encodeModelSelectionJson(target)}
        WHERE thread_id = ${row.thread_id}`;
    } else {
      yield* Effect.logWarning("assistant groups: request thread kept its model", {
        threadId: row.thread_id,
        cause: switched.failure,
      });
    }
  });

  /** A move `followModel` deferred while the thread was mid-turn. */
  const applyPendingModel = Effect.fn("AssistantGroups.applyPendingModel")(function* (
    threadId: string,
  ) {
    const row = (yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_request_threads
      WHERE thread_id = ${threadId} AND pending_model_selection IS NOT NULL`)[0];
    const pending = decodeModelSelectionJson(row?.pending_model_selection);
    if (row !== undefined && pending !== null) yield* followModel(row, pending);
  });

  const followProjectModels: AssistantGroups["Service"]["followProjectModels"] = Effect.fn(
    "AssistantGroups.followProjectModels",
  )(function* (projectIds) {
    if (projectIds.length === 0) return;
    const open = yield* sql<{ readonly request_id: string; readonly project_id: string }>`
        SELECT DISTINCT m.message_id AS request_id, m.project_id FROM assistant_group_messages m
        JOIN assistant_group_tasks t ON t.request_id = m.message_id
        WHERE m.project_id IN ${sql.in(projectIds)} AND t.status IN ${sql.in(OPEN)}`;
    yield* lock.withPermits(1)(
      Effect.forEach(open, (row) =>
        followRequestProject(row.request_id, row.project_id as ProjectId),
      ),
    );
  }, quietly("project model change"));

  /** Each of a request's threads follows the model resolved for its member in `projectId`. */
  const followRequestProject = Effect.fn("AssistantGroups.followRequestProject")(function* (
    requestId: string,
    projectId: ProjectId,
  ) {
    for (const row of yield* requestThreads(requestId)) {
      const resolved = yield* modelSelections
        .resolveForNewThread({
          projectId,
          assistantId: row.assistant_id as AssistantId,
          teamId: row.team_id as AssistantTeamId,
        })
        .pipe(Effect.result);
      if (resolved._tag === "Failure") {
        yield* Effect.logWarning("assistant groups: no model for a request thread", {
          threadId: row.thread_id,
          cause: resolved.failure,
        });
        continue;
      }
      yield* followModel(row, resolved.success.selection);
    }
  });

  /**
   * A request that ended with every task delivered or cancelled settles its members' threads: they
   * stay in history, and settling closes idle terminals, ends watches and lets the project's
   * worktree rules run. Paused or failed work, or a request waiting on the user, stays active. A
   * thread whose run is still ending is refused here and settles when that run ends.
   */
  const closeRequestIfDone = Effect.fn("AssistantGroups.closeRequestIfDone")(function* (
    requestId: string | null,
  ) {
    if (requestId === null) return;
    const tasks = yield* sql<{ readonly status: string }>`
      SELECT status FROM assistant_group_tasks WHERE request_id = ${requestId}`;
    if (tasks.length === 0 || tasks.some((task) => !DELIVERED.has(task.status))) return;
    yield* settleThreads(yield* requestThreads(requestId));
  });

  const settleThreads = Effect.fn("AssistantGroups.settleThreads")(function* (
    rows: ReadonlyArray<ThreadRow>,
  ) {
    for (const row of rows) {
      const thread = yield* inspectThread(row.thread_id as ThreadId);
      if (
        thread === undefined ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.settledOverride === "settled"
      ) {
        continue;
      }
      yield* threads
        .settleThread({
          threadId: row.thread_id as ThreadId,
          commandId: CommandId.make(`assistant-group-settle:${row.thread_id}:${yield* newId("s")}`),
          byOwnAgent: false,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("assistant groups: request thread not settled yet", {
              threadId: row.thread_id,
              cause,
            }),
          ),
        );
    }
  });

  /** Work coming back to a request (Resume, Reply, "continue") makes its settled threads active. */
  const reopenRequest = Effect.fn("AssistantGroups.reopenRequest")(function* (
    requestId: string | null,
  ) {
    if (requestId === null) return;
    for (const row of yield* requestThreads(requestId)) {
      const thread = yield* inspectThread(row.thread_id as ThreadId);
      if (thread?.settledOverride !== "settled" || thread.archivedAt !== null) continue;
      yield* engine
        .dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make(
            `assistant-group-unsettle:${row.thread_id}:${yield* newId("r")}`,
          ),
          threadId: row.thread_id as ThreadId,
          reason: "user",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("assistant groups: request thread not unsettled", {
              threadId: row.thread_id,
              cause,
            }),
          ),
        );
    }
  });

  const archiveThreads = Effect.fn("AssistantGroups.archiveThreads")(function* (
    rows: ReadonlyArray<ThreadRow>,
  ) {
    for (const row of rows) {
      const thread = yield* inspectThread(row.thread_id as ThreadId);
      if (thread !== undefined && thread.deletedAt === null && thread.archivedAt === null) {
        yield* dispatchLifecycle(
          `assistant-group-archive:${row.thread_id}:${yield* newId("a")}`,
          "thread.archive",
          row.thread_id as ThreadId,
        );
      }
    }
  });

  const labelOf = (row: MessageRow, names: ReadonlyMap<string, string>) => {
    switch (row.author) {
      case "user":
        return "user";
      case "assistant":
        return names.get(row.assistant_id ?? "") ?? "a member";
      case "agent":
        return `${row.author_label ?? "an agent"} (agent)`;
      default:
        return `schedule ${row.author_label ?? ""}`.trim();
    }
  };

  /** Queues the task into its owner's thread. True when it now holds a slot. */
  const startTask = Effect.fn("AssistantGroups.startTask")(function* (
    team: AssistantTeam,
    task: TaskRow,
  ) {
    const members = yield* activeMembers(team);
    const owner = members.find((member) => member.assistant_id === task.owner_id);
    if (owner === undefined) {
      yield* patchTask(task, { status: "paused", reason: "member_removed" });
      return false;
    }
    const failed = (reason: string) =>
      patchTask(task, { status: "failed", reason }).pipe(Effect.as(false));
    // Work from before requests existed counts its first message as its request.
    const requestId = task.request_id ?? task.request_message_id;
    const request = yield* getMessage(requestId);
    if (request === undefined) return yield* failed("request_missing");
    const exec = yield* ensureRequestThread(team, owner, request).pipe(Effect.result);
    if (exec._tag === "Failure") {
      return yield* failed(
        exec.failure.reason === "invalid" ? "outside_project" : "thread_unavailable",
      );
    }
    const seen =
      (yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_request_threads
      WHERE request_id = ${requestId} AND assistant_id = ${owner.assistant_id}`)[0]?.seen_seq ?? 0;
    // Only this request's messages: another request's never reach the member.
    const chat = yield* sql<MessageRow>`
      SELECT * FROM assistant_group_messages
      WHERE request_id = ${requestId} AND seq > ${seen} AND kind = 'message'
        AND message_id <> ${task.kind === "child" ? "" : task.request_message_id}
        AND NOT (author = 'assistant' AND assistant_id = ${owner.assistant_id})
      ORDER BY seq ASC`;
    const topSeq =
      (yield* sql<{ readonly top: number | null }>`
        SELECT MAX(seq) AS top FROM assistant_group_messages WHERE team_id = ${team.id}`)[0]?.top ??
      0;
    const names = new Map(members.map((row) => [row.assistant_id, row.name]));
    const member = (row: AssistantRow): PacketMember => ({
      name: row.name,
      handle: row.handle,
      role: row.role,
      isLead: row.assistant_id === team.leadId,
    });
    // A root from an agent or a schedule and a reply already name their sender in the instruction.
    const parent = task.kind === "child" ? yield* getTask(task.parent_id ?? "") : undefined;
    const from =
      task.kind === "root"
        ? (yield* getMessage(task.request_message_id))?.author === "user"
          ? "the user"
          : null
        : parent === undefined
          ? null
          : `${yield* nameOf(parent.owner_id)} (a teammate, not the user)`;
    const replyTarget = (yield* getMessage(task.request_message_id))?.reply_to ?? "";
    const mentioned = [
      ...new Set([
        ...sourceSeqsOf(task),
        ...[...task.instruction.matchAll(/#(\d+)/g)].map((match) => Number(match[1])),
      ]),
    ].slice(0, QUOTED_MESSAGES);
    const given = yield* sql<TaskRow>`
      SELECT t.* FROM assistant_group_tasks t
      JOIN assistant_group_tasks p ON p.task_id = t.parent_id
      WHERE t.request_id = ${requestId} AND p.owner_id = ${owner.assistant_id} AND t.kind = 'child'
        AND t.task_id <> ${task.task_id} AND t.status IN ${sql.in([...ACTIVE, "paused"])}
      ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ${STOPPED_LISTED}`;
    const stopped = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks
      WHERE request_id = ${requestId} AND owner_id = ${owner.assistant_id}
        AND task_id <> ${task.task_id} AND status IN ('paused', 'failed')
      ORDER BY updated_at DESC, rowid DESC LIMIT ${STOPPED_LISTED}`;
    const quoted = yield* sql<MessageRow>`
      SELECT * FROM assistant_group_messages
      WHERE request_id = ${requestId} AND kind = 'message'
        AND message_id <> ${task.request_message_id}
        AND (seq IN ${sql.in(mentioned.length === 0 ? [-1] : mentioned)} OR message_id = ${replyTarget})
      ORDER BY seq ASC`;
    const packet = groupTaskPacket({
      group: team.name,
      taskId: task.task_id,
      kind: task.kind as AssistantGroupTaskKind,
      self: member(owner),
      members: members.map(member),
      news: chat.map((row) => ({ seq: row.seq, from: labelOf(row, names), text: row.text })),
      request: request.title ?? titleFromText(request.text),
      quoted: quoted.map((row) => ({ seq: row.seq, from: labelOf(row, names), text: row.text })),
      from,
      instruction: task.instruction,
      expectedResult: task.expected_result,
      resources: resourcesOf(task),
      given: given.map((row) => ({
        taskId: row.task_id,
        status: row.status,
        owner: names.get(row.owner_id) ?? "a member",
        instruction: clip(row.instruction, STOPPED_INSTRUCTION_CHARS),
      })),
      stopped: stopped.map((row) => ({
        taskId: row.task_id,
        status: row.status,
        reason: row.reason,
        instruction: clip(row.instruction, STOPPED_INSTRUCTION_CHARS),
      })),
      followup: task.followup,
      instructions: team.instructions ?? "",
      memories: team.memories ?? [],
    });
    const messageId = taskMessageId(task.task_id, task.revision);
    const attachments = yield* copyForThread(
      exec.success.threadId,
      attachmentsOf((yield* getMessage(task.request_message_id)) ?? EMPTY_MESSAGE),
    );
    const sent = yield* threads
      .sendToThread({
        projectId: exec.success.projectId,
        commandId: CommandId.make(messageId),
        messageId: MessageId.make(messageId),
        threadId: exec.success.threadId,
        text: packet,
        attachments,
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (sent._tag === "Failure") {
      yield* Effect.logWarning("assistant groups: could not queue a task", {
        taskId: task.task_id,
        cause: sent.failure,
      });
      return yield* failed("could_not_start");
    }
    yield* sql`
      UPDATE assistant_group_request_threads SET seen_seq = ${topSeq}
      WHERE request_id = ${requestId} AND assistant_id = ${owner.assistant_id}`;
    yield* patchTask(task, { status: "running", reason: null });
    return true;
  });

  /**
   * Compact folds the chat since the last summary into a new one. It mixes requests, so only the
   * lead reads it, when it routes. A failure or a provider without the operation keeps the old one.
   */
  const summarize = Effect.fn("AssistantGroups.summarize")(function* (teamId: string) {
    if (summarizing.has(teamId)) return false;
    summarizing.add(teamId);
    return yield* Effect.gen(function* () {
      const team = yield* loadTeam(teamId);
      const boundary = yield* boundaryOf(teamId);
      const through = Math.max(
        boundary,
        (yield* sql<{ readonly through_seq: number }>`
          SELECT through_seq FROM assistant_group_summaries WHERE team_id = ${teamId}`)[0]
          ?.through_seq ?? 0,
      );
      const top =
        (yield* sql<{ readonly top: number | null }>`
          SELECT MAX(seq) AS top FROM assistant_group_messages
          WHERE team_id = ${teamId} AND seq > ${through} AND kind = 'message'`)[0]?.top ?? 0;
      // Nothing new since the last summary: it already covers the chat.
      if (top === 0) return true;
      const previous =
        (yield* sql<{ readonly summary: string }>`
          SELECT summary FROM assistant_group_summaries WHERE team_id = ${teamId}`)[0]?.summary ??
        null;
      const fresh = yield* sql<MessageRow>`
        SELECT * FROM assistant_group_messages
        WHERE team_id = ${teamId} AND seq > ${through} AND seq <= ${top} AND kind = 'message'
        ORDER BY seq DESC`;
      const names = new Map(
        (yield* activeMembers(team)).map((row) => [row.assistant_id, row.name]),
      );
      const read: Array<{ readonly from: string; readonly text: string }> = [];
      let used = 0;
      for (const row of fresh) {
        const text = clip(row.text, SUMMARY_MESSAGE_CHARS);
        if (used + text.length > SUMMARY_INPUT_CHARS && read.length > 0) break;
        used += text.length;
        read.unshift({ from: labelOf(row, names), text });
      }
      const summarizeCall = textGeneration.summarizeAssistantGroup;
      if (summarizeCall === undefined) return false;
      const { textGenerationModelSelection } = yield* serverSettings.getSettings;
      const made = yield* summarizeCall({
        cwd: config.baseDir,
        modelSelection: textGenerationModelSelection,
        groupName: team.name,
        previousSummary: previous,
        messages: read,
      });
      const summary = clip(made.summary.trim(), PACKET_SUMMARY_CHARS);
      if (summary === "") return false;
      // A group deleted meanwhile keeps no summary behind.
      yield* loadTeam(teamId);
      // A New conversation, Compact or Clear that ran while the model worked wins.
      yield* sql`
        INSERT INTO assistant_group_summaries (team_id, summary, through_seq, updated_at)
        SELECT ${teamId}, ${summary}, ${top}, ${yield* nowIso}
        WHERE (SELECT COALESCE(MAX(seq), 0) FROM assistant_group_messages
            WHERE team_id = ${teamId} AND kind = 'boundary') = ${boundary}
          AND EXISTS (SELECT 1 FROM assistant_group_messages
            WHERE team_id = ${teamId} AND seq = ${top} AND kind = 'message')
        ON CONFLICT (team_id) DO UPDATE SET summary = excluded.summary,
          through_seq = excluded.through_seq, updated_at = excluded.updated_at
        WHERE excluded.through_seq > through_seq`;
      return true;
    }).pipe(Effect.ensuring(Effect.sync(() => void summarizing.delete(teamId))));
  });

  /** Sets why a queued task waits without moving it in the queue, which orders by updated_at. */
  const setWaitReason = Effect.fn("AssistantGroups.setWaitReason")(function* (
    task: TaskRow,
    reason: string | null,
  ) {
    if (task.reason === reason) return;
    const rows = yield* sql<TaskRow>`
      UPDATE assistant_group_tasks SET reason = ${reason} WHERE task_id = ${task.task_id} RETURNING *`;
    yield* publishTask(rows[0]!);
  });

  /**
   * The provider instance a task runs on: its request thread's, or the one that thread would be
   * launched on. Undefined when neither can be told.
   */
  const taskInstance = Effect.fn("AssistantGroups.taskInstance")(function* (
    team: AssistantTeam,
    task: TaskRow,
  ) {
    const requestId = task.request_id ?? task.request_message_id;
    const row = (yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_request_threads
      WHERE request_id = ${requestId} AND assistant_id = ${task.owner_id}`)[0];
    const thread = row === undefined ? undefined : yield* inspectThread(row.thread_id as ThreadId);
    if (thread !== undefined && thread.deletedAt === null) {
      return thread.modelSelection.instanceId as string;
    }
    const member = (yield* activeMembers(team)).find((row) => row.assistant_id === task.owner_id);
    const request = yield* getMessage(requestId);
    if (member === undefined || request === undefined) return undefined;
    const resolved = yield* modelSelections
      .resolveForNewThread({
        projectId: (request.project_id ?? member.project_id) as ProjectId,
        assistantId: member.assistant_id as AssistantId,
        teamId: team.id,
      })
      .pipe(Effect.option);
    return Option.isSome(resolved) ? (resolved.value.selection.instanceId as string) : undefined;
  });

  /**
   * Starts queued tasks, oldest first, while the group has free slots. A task waits while another
   * running or earlier-queued one holds an overlapping resource. Only running tasks hold: a parent
   * waiting on its children has ended its run and gives its resources up, so no wait is circular.
   */
  const pump = Effect.fn("AssistantGroups.pump")(function* (teamId: string) {
    const team = yield* loadTeam(teamId).pipe(Effect.orElseSucceed(() => undefined));
    if (team === undefined || team.archivedAt !== null) return;
    // Queued work of a request whose root is stopped waits until the user picks it up again.
    const live = yield* sql<TaskRow>`
      SELECT t.* FROM assistant_group_tasks t
      JOIN assistant_group_tasks r ON r.task_id = t.root_id
      WHERE t.team_id = ${teamId} AND (t.status IN ('running', 'usage_limited')
        OR (t.status = 'queued' AND r.status NOT IN ${sql.in(STOPPED_ROOT)}))
      ORDER BY t.updated_at ASC, t.rowid ASC`;
    let running = 0;
    const held = new Map<string, string>();
    const hold = (task: TaskRow, who: string) => {
      for (const resource of resourcesOf(task)) if (!held.has(resource)) held.set(resource, who);
    };
    // A usage-limited task resumes mid-work, so it keeps its resources but frees its slot. Work
    // that would run on its provider instance waits too, whoever owns it.
    const limited = new Set<string>();
    for (const task of live) {
      if (task.status !== "running" && task.status !== "usage_limited") continue;
      if (task.status === "running") running += 1;
      else {
        const instance = yield* taskInstance(team, task);
        if (instance !== undefined) limited.add(instance);
      }
      if (resourcesOf(task).length > 0) hold(task, yield* nameOf(task.owner_id));
    }
    for (const task of live) {
      if (task.status !== "queued") continue;
      const wanted = resourcesOf(task);
      const instance = limited.size === 0 ? undefined : yield* taskInstance(team, task);
      if (instance !== undefined && limited.has(instance)) {
        if (wanted.length > 0) hold(task, yield* nameOf(task.owner_id));
        yield* setWaitReason(task, "waiting for a usage limit");
        continue;
      }
      const clash = firstConflict(wanted, held);
      // A task that waits still claims its resources, so a later one cannot overtake it.
      if (wanted.length > 0 && (clash !== null || running >= ASSISTANT_GROUP_PARALLEL_LIMIT)) {
        hold(task, yield* nameOf(task.owner_id));
      }
      if (clash !== null) {
        yield* setWaitReason(task, `waiting for ${clash.resource} (used by ${clash.holder})`);
        continue;
      }
      if (running >= ASSISTANT_GROUP_PARALLEL_LIMIT) {
        yield* setWaitReason(task, null);
        continue;
      }
      if (wanted.length > 0) hold(task, yield* nameOf(task.owner_id));
      if (yield* startTask(team, task)) running += 1;
    }
  });

  /** A parent that waited on its children runs again once they are all settled. */
  const resumeParent = Effect.fn("AssistantGroups.resumeParent")(function* (child: TaskRow) {
    if (child.parent_id === null) return;
    const parent = yield* getTask(child.parent_id);
    if (parent === undefined || parent.status !== "waiting") return;
    if ((yield* unsettledChildren(parent.task_id)).length > 0) return;
    const children = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks WHERE parent_id = ${parent.task_id} ORDER BY rowid ASC`;
    // ponytail: every child is listed again on a later wait; track what was reported if that grows.
    const results = yield* Effect.forEach(children, (row) =>
      nameOf(row.owner_id).pipe(
        Effect.map((owner) => ({
          owner,
          status: row.status,
          text: row.result_text ?? row.reason ?? "",
        })),
      ),
    );
    yield* patchTask(parent, {
      status: "queued",
      reason: null,
      revision: parent.revision + 1,
      result_text: null,
      followup: childResultsText(results),
    });
  });

  const instructionFor = (author: GroupAuthor, text: string) =>
    author.kind === "agent"
      ? `Request from ${author.label} (an agent, not the user):\n${text}`
      : author.kind === "routine"
        ? `Scheduled request ${author.label}:\n${text}`
        : text;

  /** The model the lead would route on: its own conversation's, else the project's default. */
  const leadSelection = Effect.fn("AssistantGroups.leadSelection")(function* (lead: AssistantRow) {
    const current =
      lead.thread_id === null ? undefined : yield* inspectThread(lead.thread_id as ThreadId);
    return (
      current?.modelSelection ?? (yield* assistants.defaultModel(lead.project_id as ProjectId))
    );
  });

  /** The lead's own provider instance must offer routing: no usage-limit fallback stands in for it. */
  const canRoute = Effect.fn("AssistantGroups.canRoute")(function* (selection: ModelSelection) {
    const instance = yield* registry.getInstance(selection.instanceId);
    return instance?.textGeneration.routeAssistantGroup !== undefined;
  });

  const openRoots = Effect.fn("AssistantGroups.openRoots")(function* (
    team: AssistantTeam,
    message: MessageRow,
    recipients: ReadonlyArray<AssistantRow>,
    instruction: string,
  ) {
    const tasks: TaskRow[] = [];
    for (const recipient of recipients) {
      tasks.push(
        yield* insertTask({
          teamId: team.id,
          kind: "root",
          requestMessageId: message.message_id,
          requestId: message.request_id ?? message.message_id,
          ownerId: recipient.assistant_id,
          instruction,
          status: "queued",
        }),
      );
    }
    return tasks;
  });

  const descendants = Effect.fn("AssistantGroups.descendants")(function* (task: TaskRow) {
    const all = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks WHERE root_id = ${task.root_id}`;
    const found: TaskRow[] = [];
    const queue = [task.task_id];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const child of all.filter((row) => row.parent_id === next)) {
        found.push(child);
        queue.push(child.task_id);
      }
    }
    return found;
  });

  /** Stops a task and everything under it that is still in flight. */
  const pauseBranch = Effect.fn("AssistantGroups.pauseBranch")(function* (
    task: TaskRow,
    reason: string,
  ) {
    const paused = yield* pauseTask(task, reason);
    for (const child of yield* descendants(task)) yield* pauseTask(child, reason);
    return paused;
  });

  /**
   * The user took part in these requests, so both hand-off counts start over: the caps stop loops
   * that run unattended, not work the user is following. The counts are never shown, so changing
   * them publishes nothing.
   */
  const restartHandoffs = Effect.fn("AssistantGroups.restartHandoffs")(function* (
    rootIds: ReadonlyArray<string>,
  ) {
    if (rootIds.length === 0) return;
    yield* sql`
      UPDATE assistant_group_tasks SET hops = 0, undelivered_hops = 0
      WHERE task_id IN ${sql.in(rootIds)}`;
  });

  /** The user wrote in a request: every hand-off count of that request starts over, no other's. */
  const userReached = Effect.fn("AssistantGroups.userReached")(function* (requestId: string) {
    const roots = yield* sql<{ readonly task_id: string }>`
      SELECT task_id FROM assistant_group_tasks WHERE request_id = ${requestId} AND kind = 'root'`;
    yield* restartHandoffs(roots.map((row) => row.task_id));
  });

  /**
   * A paused or failed task runs again, with its owner or a new one, and so does the stopped work
   * under it; a task with open subtasks waits for them. When the whole request is stopped, it picks
   * up from its root whichever card the user chose. Only the user does this.
   */
  const requeue = Effect.fn("AssistantGroups.requeue")(function* (
    task: TaskRow,
    ownerId: string = task.owner_id,
  ) {
    const stopped = (row: TaskRow) => row.status === "paused" || row.status === "failed";
    const root = task.root_id === task.task_id ? task : yield* getTask(task.root_id);
    const top = root !== undefined && stopped(root) ? root : task;
    const below = yield* descendants(top);
    const branch = new Set([top.task_id, task.task_id]);
    for (const row of below) {
      if (stopped(row) && row.parent_id !== null && branch.has(row.parent_id)) {
        branch.add(row.task_id);
      }
    }
    const waitsForChildren = (row: TaskRow) =>
      below.some(
        (child) =>
          child.parent_id === row.task_id &&
          (branch.has(child.task_id) ||
            !SETTLED.includes(child.status as AssistantGroupTaskStatus)),
      );
    let next = task;
    for (const row of [top, ...below].filter((candidate) => branch.has(candidate.task_id))) {
      const chosen = row.task_id === task.task_id;
      const done = yield* patchTask(row, {
        status: waitsForChildren(row) ? "waiting" : "queued",
        reason: null,
        owner_id: chosen ? ownerId : row.owner_id,
        revision: row.revision + 1,
        result_text: null,
      });
      if (chosen) next = done;
    }
    yield* restartHandoffs([task.root_id]);
    return next;
  });

  const routingNow = new Set<string>();

  /** The group's projects with their titles, in member order, a deleted one left out: what every offer and inference reads. */
  const groupProjects = Effect.fn("AssistantGroups.groupProjects")(function* (
    team: AssistantTeam,
    members: ReadonlyArray<AssistantRow>,
  ) {
    const ids = assistantGroupProjectIds(members.map(toAssistant), team.projectIds);
    if (ids.length === 0) return [];
    const rows = yield* sql<{ readonly project_id: string; readonly title: string }>`
      SELECT project_id, title FROM projection_projects
      WHERE project_id IN ${sql.in(ids)} AND deleted_at IS NULL`;
    return ids.flatMap((id) => {
      const row = rows.find((candidate) => candidate.project_id === id);
      return row === undefined ? [] : [{ id: row.project_id, name: row.title }];
    });
  });

  /** A project's title for the chat, even when no member lists it any more. */
  const projectTitle = (projectId: string | null) =>
    sql<{ readonly title: string }>`
      SELECT title FROM projection_projects WHERE project_id = ${projectId ?? ""}`.pipe(
      Effect.map((rows) => rows[0]?.title ?? "this project"),
    );

  /** Sets a request's project (and the lead's title) on its first message, for every client. */
  const setRequestProject = Effect.fn("AssistantGroups.setRequestProject")(function* (
    request: MessageRow,
    projectId: string,
    title: string | null,
  ) {
    const rows = yield* sql<MessageRow>`
      UPDATE assistant_group_messages
      SET project_id = ${projectId}, title = COALESCE(${title}, title)
      WHERE message_id = ${request.message_id} RETURNING *`;
    if (rows[0] !== undefined) yield* publishMessage(rows[0]);
    yield* followRequestProject(request.message_id, projectId as ProjectId);
  });

  const route = Effect.fn("AssistantGroups.route")(function* (
    teamId: string,
    messageId: string,
    leadId: string,
    selection: ModelSelection,
  ) {
    const prepared = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const team = yield* loadTeam(teamId);
        const members = yield* activeMembers(team);
        const lead = members.find((member) => member.assistant_id === leadId);
        const trigger = yield* getMessage(messageId);
        if (lead === undefined || trigger === undefined) return undefined;
        const request =
          trigger.request_id === null
            ? trigger
            : ((yield* getMessage(trigger.request_id)) ?? trigger);
        // Until a request has started, every message in it routes the request itself.
        const started =
          (yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM assistant_group_tasks
            WHERE request_id = ${request.message_id}`)[0]!.n > 0;
        const message = started ? trigger : request;
        const projects = yield* groupProjects(team, members);
        // A request that already ran without one (from before requests had projects) keeps going.
        const needsProject = !started && request.project_id === null && projects.length > 1;
        // With the project known the lead only sees who can work there; otherwise it is checked after.
        // A request that started without one runs in each member's home, so nobody is left out.
        const knownProject =
          request.project_id ?? (started || needsProject ? null : (projects[0]?.id ?? null));
        const candidates = members.filter((member) => worksIn(member, team, knownProject));
        const names = new Map(members.map((member) => [member.assistant_id, member.name]));
        const recent = yield* sql<MessageRow>`
          SELECT * FROM assistant_group_messages
          WHERE team_id = ${teamId} AND seq < ${message.seq} AND kind = 'message'
            AND seq > ${yield* boundaryOf(teamId)}
          ORDER BY seq DESC LIMIT ${ROUTING_HISTORY_MESSAGES}`;
        const followUps = started
          ? []
          : yield* sql<MessageRow>`
              SELECT * FROM assistant_group_messages
              WHERE request_id = ${request.message_id} AND seq > ${request.seq}
                AND kind IN ('message', 'notice')
              ORDER BY seq ASC LIMIT ${ROUTING_HISTORY_MESSAGES}`;
        const summary =
          (yield* sql<{ readonly summary: string }>`
            SELECT summary FROM assistant_group_summaries WHERE team_id = ${teamId}`)[0]?.summary ??
          null;
        const named = assistantGroupAddress(
          message.text,
          members.map((member) => ({
            id: member.assistant_id,
            handle: member.handle,
            name: member.name,
          })),
        );
        return {
          team,
          members,
          candidates,
          lead,
          trigger,
          request,
          message,
          started,
          projects,
          needsProject,
          // Two `#projects` in the text: the lead asks which one instead of picking.
          mentionedProjects: needsProject
            ? assistantGroupProjectMentions(trigger.text, projects)
            : [],
          named:
            named?.map((member) => member.id) ??
            (members.length === 1 ? [members[0]!.assistant_id] : null),
          summary,
          recent: recent.toReversed().map((row) => ({ from: labelOf(row, names), text: row.text })),
          followUps: followUps.map((row) => ({ from: labelOf(row, names), text: row.text })),
        };
      }),
    );
    if (prepared === undefined) return;
    // The model call runs outside the lock: it takes seconds and nothing else should wait on it.
    const routeCall = textGeneration.routeAssistantGroup;
    const nobodyCan = !prepared.needsProject && prepared.candidates.length === 0;
    const picked =
      (prepared.named !== null && !prepared.needsProject) || nobodyCan
        ? undefined
        : yield* (
            routeCall === undefined
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "routeAssistantGroup",
                    detail: "unsupported_operation",
                  }),
                )
              : routeCall({
                  cwd: config.baseDir,
                  modelSelection: selection,
                  groupName: prepared.team.name,
                  members: prepared.candidates.map((member) => ({
                    id: member.assistant_id,
                    handle: member.handle,
                    name: member.name,
                    role: member.role,
                    instructions: member.instructions,
                  })),
                  recentMessages: prepared.recent,
                  request: prepared.message.text,
                  followUps: prepared.followUps,
                  summary: prepared.summary,
                  projects: prepared.needsProject ? prepared.projects : [],
                  newRequest: !prepared.started,
                })
          ).pipe(Effect.result);
    yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const { lead, message, request, trigger } = prepared;
          // A repeat of the same routing, or a group that changed meanwhile, opens nothing twice.
          if ((yield* tasksOfMessage(message.message_id)).length > 0) return;
          const team = yield* loadTeam(teamId).pipe(Effect.orElseSucceed(() => undefined));
          if (team === undefined) return;
          const answer = picked?._tag === "Success" ? picked.success : undefined;
          const known = new Set(prepared.members.map((member) => member.assistant_id));
          const inferred =
            prepared.mentionedProjects.length > 1
              ? undefined
              : prepared.projects.find((project) => project.id === answer?.projectId);
          const current = (yield* getMessage(request.message_id)) ?? request;
          if (current.project_id === null && prepared.needsProject) {
            if (inferred === undefined) {
              // Ambiguous: the lead asks instead of guessing; the user's answer routes it again.
              yield* insertMessage({
                teamId,
                author: "assistant",
                assistantId: leadId,
                kind: "notice",
                text:
                  answer?.question?.trim() ||
                  `Which project is this for: ${joinNames(
                    (prepared.mentionedProjects.length > 1
                      ? prepared.mentionedProjects
                      : prepared.projects
                    ).map((project) => project.name),
                    "or",
                  )}?`,
                replyTo: trigger.message_id,
                requestId: request.message_id,
                asksProject: true,
              });
              return;
            }
          }
          const decided =
            current.project_id === null ? (inferred ?? prepared.projects[0]) : undefined;
          if (decided !== undefined) {
            yield* setRequestProject(
              current,
              decided.id,
              prepared.started ? null : answer?.title?.trim() || null,
            );
          } else if (!prepared.started && (answer?.title?.trim() ?? "") !== "") {
            const rows = yield* sql<MessageRow>`
              UPDATE assistant_group_messages SET title = ${answer!.title!.trim()}
              WHERE message_id = ${request.message_id} RETURNING *`;
            if (rows[0] !== undefined) yield* publishMessage(rows[0]);
          }
          if (nobodyCan && prepared.named === null) {
            const projectId = current.project_id ?? decided?.id ?? null;
            yield* insertMessage({
              teamId,
              author: "assistant",
              assistantId: leadId,
              kind: "notice",
              text: `Nobody in the group can work in ${yield* projectTitle(projectId)}, so nobody got this.`,
              replyTo: trigger.message_id,
              requestId: request.message_id,
            });
            return;
          }
          const ids = prepared.named ?? [
            ...new Set((answer?.assistantIds ?? []).filter((id) => known.has(id))),
          ];
          if (ids.length === 0 && answer?.noReply === true) {
            // The lead found nothing to do; the muted line also keeps the message from being routed again.
            yield* insertMessage({
              teamId,
              author: "assistant",
              assistantId: leadId,
              kind: "change",
              text: NO_REPLY_NOTE,
              replyTo: trigger.message_id,
              requestId: request.message_id,
            });
            return;
          }
          const author: GroupAuthor =
            message.author === "agent"
              ? {
                  kind: "agent",
                  assistantId: message.assistant_id as AssistantId | null,
                  label: message.author_label ?? "an agent",
                }
              : message.author === "routine"
                ? { kind: "routine", label: message.author_label ?? "" }
                : { kind: "user" };
          const instruction = instructionFor(author, message.text);
          if (ids.length === 0) {
            yield* insertTask({
              teamId,
              kind: "root",
              requestMessageId: message.message_id,
              requestId: request.message_id,
              ownerId: leadId,
              instruction,
              status: "paused",
              reason: "routing_failed",
            });
            return;
          }
          const named = ids.flatMap((id) =>
            prepared.members.filter((member) => member.assistant_id === id),
          );
          const projectId = current.project_id ?? decided?.id ?? null;
          const recipients = named.filter((member) => worksIn(member, team, projectId));
          if (recipients.length < named.length) {
            yield* insertMessage({
              teamId,
              author: "assistant",
              assistantId: leadId,
              kind: "notice",
              text: outsideProjectText(
                named.filter((member) => !recipients.includes(member)),
                yield* projectTitle(projectId),
                recipients,
              ),
              replyTo: trigger.message_id,
              requestId: request.message_id,
            });
            if (recipients.length === 0) return;
          }
          if (author.kind === "user" || trigger.author === "user") {
            yield* userReached(request.message_id);
          }
          yield* openRoots(team, message, recipients, instruction);
          const pickedByLead = prepared.needsProject && inferred !== undefined;
          const toOthers = !(ids.length === 1 && ids[0] === leadId);
          // The line also marks a later message that routed its request as handled.
          if (pickedByLead || toOthers || trigger.message_id !== message.message_id) {
            const who = `${lead.name} (lead)`;
            const routed = toOthers
              ? `routed it to ${joinNames(recipients.map((member) => member.name))}`
              : "took it";
            yield* insertMessage({
              teamId,
              author: "assistant",
              assistantId: leadId,
              kind: "routing",
              text: pickedByLead
                ? `${who} picked ${inferred!.name} and ${routed}`
                : `${who} ${routed}`,
              replyTo: trigger.message_id,
              requestId: request.message_id,
            });
          }
          yield* pump(teamId);
        }),
      )
      .pipe(storage);
  });

  /** Routes in the background; a message already being routed is not routed twice. */
  const startRoute = Effect.fn("AssistantGroups.startRoute")(function* (
    teamId: string,
    messageId: string,
    leadId: string,
    selection: ModelSelection,
  ) {
    if (routingNow.has(messageId)) return;
    routingNow.add(messageId);
    yield* FiberSet.run(
      routing,
      route(teamId, messageId, leadId, selection).pipe(
        storage,
        quietly("routing"),
        Effect.ensuring(Effect.sync(() => void routingNow.delete(messageId))),
      ),
    );
  });

  /** Messages of a group nobody has taken: the lead routes them, and with no lead they keep waiting. */
  const routePending = Effect.fn("AssistantGroups.routePending")(function* (team: AssistantTeam) {
    if (team.archivedAt !== null) return;
    const lead = (yield* activeMembers(team)).find((row) => row.assistant_id === team.leadId);
    if (lead === undefined) return;
    const pending = yield* sql<MessageRow>`
      SELECT * FROM assistant_group_messages m
      WHERE m.team_id = ${team.id} AND m.kind = 'message' AND m.author <> 'assistant'
        AND NOT EXISTS (
          SELECT 1 FROM assistant_group_tasks t WHERE t.request_message_id = m.message_id)
        AND NOT EXISTS (
          SELECT 1 FROM assistant_group_messages n
          WHERE n.reply_to = m.message_id AND n.kind IN ('notice', 'change', 'routing'))
      ORDER BY m.seq ASC`;
    if (pending.length === 0) return;
    const selection = yield* leadSelection(lead);
    const capable = yield* canRoute(selection);
    for (const message of pending) {
      if (capable) {
        yield* startRoute(team.id, message.message_id, lead.assistant_id, selection);
      } else {
        yield* insertMessage({
          teamId: team.id,
          author: "assistant",
          assistantId: null,
          kind: "notice",
          text: UNROUTED_NOTICE,
          replyTo: message.message_id,
          requestId: message.request_id,
        });
      }
    }
  });

  /** Moves the uploads a message carries to ids the group owns, so they outlive the 24h sweep. */
  const claimUploads = Effect.fn("AssistantGroups.claimUploads")(function* (
    teamId: string,
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    if (attachments.length === 0) return { attachments, claimedPaths: [] };
    // Anything but a pending upload would let a post name another thread's file.
    if (!attachments.every(AttachmentClaims.attachmentIsPendingUpload)) {
      return yield* invalid("Attachments must be fresh uploads.");
    }
    return yield* AttachmentClaims.claimPendingAttachments({
      threadId: `group-${sha256(teamId).slice(0, 16)}`,
      attachments,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(DocumentText.DocumentText, documents),
      Effect.mapError((error) => assistantError("invalid", error.message)),
    );
  });

  /**
   * The member's own copies of a message's files, so deleting its thread never removes the group's.
   * A file that cannot be copied is left out; the task and the other files still go.
   */
  const copyForThread = Effect.fn("AssistantGroups.copyForThread")(function* (
    threadId: ThreadId,
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    const copies: ChatAttachment[] = [];
    for (const attachment of attachments) {
      // The extension suffix stays: lookups by id alone (cleanup, assets, Codex) find files by it.
      const base = createDeterministicAttachmentId(threadId, attachment.id);
      const extension = parseAttachmentFileExtension(attachment.id);
      const id = base === null ? null : `${base}${extension === null ? "" : `-${extension}`}`;
      const copy = id === null ? null : { ...attachment, id: ChatAttachmentId.make(id) };
      const from = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      const to =
        copy === null
          ? null
          : resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: copy });
      if (copy === null || from === null || to === null) continue;
      const done = yield* Effect.gen(function* () {
        if (!(yield* fileSystem.exists(to))) yield* fileSystem.copyFile(from, to);
        if (yield* fileSystem.exists(`${from}.txt`)) {
          yield* fileSystem.copyFile(`${from}.txt`, `${to}.txt`);
        }
      }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("assistant groups: could not copy an attachment", {
            attachmentId: attachment.id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (done) copies.push(copy);
    }
    return copies;
  });

  const post: AssistantGroups["Service"]["post"] = Effect.fn("AssistantGroups.post")(
    function* (input, author) {
      const outcome = yield* lock
        .withPermits(1)(
          Effect.gen(function* () {
            const team = yield* loadTeam(input.teamId);
            if (team.archivedAt !== null) {
              return yield* assistantError("archived", "This group is archived.");
            }
            if (input.clientRequestId !== undefined) {
              const repeat = yield* sql<MessageRow>`
              SELECT * FROM assistant_group_messages
              WHERE team_id = ${team.id} AND client_request_id = ${input.clientRequestId}`;
              if (repeat[0] !== undefined) return { message: repeat[0], lead: undefined };
            }
            const members = yield* activeMembers(team);
            const projectList = yield* groupProjects(team, members);
            const projects = projectList.map((project) => project.id as ProjectId);
            if (input.projectId !== undefined && !projects.includes(input.projectId)) {
              return yield* invalid("That project is not one of the group's projects.");
            }
            // `#project` in the text picks like the picker does; the picker wins when they differ.
            const mentioned = assistantGroupProjectMentions(input.text, projectList);
            // A reply continues the request of the message it answers.
            let request: MessageRow | undefined;
            let replyOwnerId: string | null = null;
            if (input.replyToMessageId !== undefined) {
              const target = yield* getMessage(input.replyToMessageId);
              if (target?.team_id === team.id && target.request_id !== null) {
                request = yield* getMessage(target.request_id);
              }
              const task =
                target?.team_id === team.id &&
                target.author === "assistant" &&
                target.task_id !== null
                  ? yield* getTask(target.task_id)
                  : undefined;
              replyOwnerId = task?.owner_id ?? null;
              if (!members.some((member) => member.assistant_id === replyOwnerId)) {
                replyOwnerId = null;
              }
            }
            const stopped = yield* sql<TaskRow>`
              SELECT * FROM assistant_group_tasks
              WHERE team_id = ${team.id} AND kind = 'root' AND status IN ('paused', 'failed')
                AND (${request?.message_id ?? null} IS NULL OR request_id = ${request?.message_id ?? null})
              ORDER BY updated_at DESC, rowid DESC`;
            const requestOwners =
              request === undefined
                ? []
                : yield* sql<{ readonly owner_id: string }>`
                    SELECT DISTINCT owner_id FROM assistant_group_tasks
                    WHERE request_id = ${request.message_id} AND kind = 'root'`;
            const decision = routeGroupMessage({
              requestOwnerId: requestOwners.length === 1 ? requestOwners[0]!.owner_id : null,
              text: input.text,
              members: members.map((row) => ({
                id: row.assistant_id,
                handle: row.handle,
                name: row.name,
              })),
              replyOwnerId,
              stopped: stopped.map((task) => ({ taskId: task.task_id, ownerId: task.owner_id })),
              fromUser: author.kind === "user",
            });
            const resumed =
              decision?.kind === "resume"
                ? stopped.find((task) => task.task_id === decision.taskId)
                : undefined;
            // "continue" carries on the request of the work it resumes.
            if (resumed !== undefined && request === undefined) {
              request = yield* getMessage(resumed.request_id ?? resumed.request_message_id);
            }
            const started =
              request !== undefined &&
              (yield* sql<{ readonly n: number }>`
                SELECT COUNT(*) AS n FROM assistant_group_tasks
                WHERE request_id = ${request.message_id}`)[0]!.n > 0;
            const projectId =
              request?.project_id ??
              input.projectId ??
              (mentioned.length === 1 ? (mentioned[0]!.id as ProjectId) : null) ??
              (projects.length === 1 ? projects[0]! : null);
            // A request that has not started needs its project first; with several, the lead picks.
            const needsProject = !started && projectId === null && projects.length > 1;
            // An answer in a request that has not started (the lead asked for its project) routes
            // the request itself, through the lead.
            const viaLead =
              decision === null || needsProject || (request !== undefined && !started);
            const recipients: ReadonlyArray<AssistantRow> | undefined =
              decision?.kind === "members" && !viaLead
                ? decision.ids.flatMap((id) => members.filter((row) => row.assistant_id === id))
                : undefined;
            let lead:
              | { readonly row: AssistantRow; readonly selection: ModelSelection }
              | undefined;
            if (viaLead) {
              const row = members.find((member) => member.assistant_id === team.leadId);
              const selection = row === undefined ? undefined : yield* leadSelection(row);
              const capable = selection === undefined ? false : yield* canRoute(selection);
              if (needsProject && !capable) {
                return yield* invalid(
                  "Pick the project for this request: the group has no lead that can choose it.",
                );
              }
              // With no lead the message waits; clients show it, and a lead set later routes it.
              if (row !== undefined && selection !== undefined) {
                if (!capable) {
                  return yield* assistantError("mention_required", MENTION_REQUIRED_MESSAGE);
                }
                lead = { row, selection };
              }
            }
            const claimed = yield* claimUploads(team.id, input.attachments ?? []);
            const message = yield* insertMessage({
              teamId: team.id,
              author: author.kind === "user" ? "user" : author.kind,
              assistantId: author.kind === "agent" ? author.assistantId : null,
              authorLabel: author.kind === "user" ? null : author.label,
              kind: "message",
              text: input.text,
              replyTo: input.replyToMessageId ?? null,
              clientRequestId: input.clientRequestId ?? null,
              attachments: claimed.attachments,
              requestId: request?.message_id ?? "new",
              projectId: request === undefined ? projectId : null,
              title: request === undefined ? titleFromText(input.text) : null,
            }).pipe(
              Effect.onError(() =>
                AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                ),
              ),
            );
            // The project picked while answering a request that has none yet.
            if (request !== undefined && request.project_id === null && projectId !== null) {
              yield* setRequestProject(request, projectId, null);
            }
            const picked = projectList.find((project) => project.id === input.projectId);
            if (
              picked !== undefined &&
              request?.project_id == null &&
              mentioned.length > 0 &&
              !mentioned.includes(picked)
            ) {
              yield* insertMessage({
                teamId: team.id,
                author: "assistant",
                assistantId: members.some((member) => member.assistant_id === team.leadId)
                  ? team.leadId
                  : null,
                kind: "notice",
                text: `Running this in ${picked.name}, the project you picked. The text also names ${joinNames(
                  mentioned.map((project) => project.name),
                )}.`,
                replyTo: message.message_id,
                requestId: request?.message_id ?? message.message_id,
              });
            }
            if (lead !== undefined) return { message, lead };
            if (resumed !== undefined) {
              yield* requeue(resumed);
              yield* insertMessage({
                teamId: team.id,
                author: "assistant",
                kind: "routing",
                text: `Resumed ${yield* nameOf(resumed.owner_id)}'s task`,
                replyTo: message.message_id,
                requestId: message.request_id,
              });
            } else if (recipients !== undefined) {
              const allowed = recipients.filter((row) => worksIn(row, team, projectId));
              if (allowed.length < recipients.length) {
                yield* insertMessage({
                  teamId: team.id,
                  author: "assistant",
                  assistantId: members.some((member) => member.assistant_id === team.leadId)
                    ? team.leadId
                    : null,
                  kind: "notice",
                  text: outsideProjectText(
                    recipients.filter((row) => !allowed.includes(row)),
                    yield* projectTitle(projectId),
                    allowed,
                  ),
                  replyTo: message.message_id,
                  requestId: message.request_id,
                });
              }
              if (allowed.length > 0) {
                if (author.kind === "user") yield* userReached(message.request_id!);
                yield* openRoots(team, message, allowed, instructionFor(author, input.text));
              }
            }
            yield* pump(team.id);
            return { message, lead: undefined };
          }),
        )
        .pipe(storage);
      if (outcome.lead !== undefined) {
        const { row, selection } = outcome.lead;
        yield* startRoute(input.teamId, outcome.message.message_id, row.assistant_id, selection);
        return { message: toMessage(outcome.message), tasks: [] };
      }
      // Read after the scheduler ran, so a task that started shows as running.
      const tasks = yield* tasksOfMessage(outcome.message.message_id).pipe(
        Effect.flatMap(wireTasks),
        storage,
      );
      return { message: toMessage(outcome.message), tasks };
    },
  );

  /** What the member said in the run: its last assistant message. */
  const answerOf = Effect.fn("AssistantGroups.answerOf")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const records = yield* engine
      .getThreadRecords(threadId, ["messages"], {
        messageRunIds: [runId],
        messageRoles: ["assistant"],
      })
      .pipe(Effect.orElseSucceed(() => ({ messages: [] })));
    return records.messages.findLast((message) => message.text.trim() !== "")?.text.trim();
  });

  /**
   * A finished task moves its request on, unless it is a teammate's answer to a question, says
   * nothing, or repeats word for word what the same member already told the same asker in it.
   */
  const isDelivery = Effect.fn("AssistantGroups.isDelivery")(function* (
    task: TaskRow,
    answer: string,
  ) {
    if (task.kind === "reply" || answer === NO_ANSWER) return false;
    if (task.parent_id === null) return true;
    const repeated = yield* sql`
      SELECT 1 FROM assistant_group_tasks t
      JOIN assistant_group_tasks p ON p.task_id = t.parent_id
      WHERE t.root_id = ${task.root_id} AND t.task_id <> ${task.task_id}
        AND t.status = 'completed' AND t.owner_id = ${task.owner_id} AND t.result_text = ${answer}
        AND p.owner_id = (SELECT owner_id FROM assistant_group_tasks WHERE task_id = ${task.parent_id})
      LIMIT 1`;
    return repeated.length === 0;
  });

  /**
   * The task a run carries: its own, or for a usage-limit continuation (at the reset or on a
   * provider switch) the task of the run it continues, which ran just before it.
   */
  const taskOfRun = Effect.fn("AssistantGroups.taskOfRun")(function* (run: OrchestrationV2Run) {
    const key = parseTaskMessageId(run.userMessageId);
    if (key !== null) {
      const task = yield* getTask(key.taskId);
      return task?.revision === key.revision ? task : undefined;
    }
    if (!isLimitContinuation(run)) return undefined;
    const { runs } = yield* engine
      .getThreadRecords(run.threadId, ["runs"])
      .pipe(Effect.orElseSucceed(() => ({ runs: [] as ReadonlyArray<OrchestrationV2Run> })));
    let current = run;
    for (let step = 0; step < runs.length; step += 1) {
      const previous = latestExecutedRun(
        runs.filter((candidate) => candidate.ordinal < current.ordinal),
      );
      if (previous === null) return undefined;
      const previousKey = parseTaskMessageId(previous.userMessageId);
      if (previousKey !== null) {
        const task = yield* getTask(previousKey.taskId);
        return task?.revision === previousKey.revision &&
          (task.status === "usage_limited" || task.status === "running")
          ? task
          : undefined;
      }
      if (!isLimitContinuation(previous)) return undefined;
      current = previous;
    }
    return undefined;
  });

  const finishRun = Effect.fn("AssistantGroups.finishRun")(function* (run: OrchestrationV2Run) {
    const task = yield* taskOfRun(run);
    if (task === undefined) return;
    if (!ENDED_RUN.has(run.status)) {
      if (task.status === "usage_limited" && run.status !== "queued" && isLimitContinuation(run)) {
        yield* patchTask(task, { status: "running", reason: null });
      }
      return;
    }
    // A task already stopped or moved on: this run's ending changes nothing. A continuation whose
    // start was not seen still ends the task it continues.
    if (task.status !== "running" && !(task.status === "usage_limited" && isLimitContinuation(run)))
      return;
    const runner = (yield* threadRowOf(run.threadId))?.assistant_id;
    const failure =
      run.status === "failed"
        ? latestRootProviderFailure(
            run,
            (yield* engine
              .getThreadRecords(run.threadId, ["turnItems"], {
                turnItemTypes: ["error"],
                turnItemRunIds: [run.id],
              })
              .pipe(Effect.orElseSucceed(() => ({ turnItems: [] })))).turnItems,
          )
        : null;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (run.status === "interrupted") {
      yield* patchTask(task, { status: "paused", reason: "stopped" });
    } else if (
      failure?.class === "usage_limit" &&
      continuesAtReset(
        failure.resetAt,
        run.completedAt ? DateTime.toEpochMillis(run.completedAt) : nowMs,
        nowMs,
        (yield* serverSettings.getSettings).autoResumeLimitedThreads,
      )
    ) {
      // Not settled: the thread continues it at the reset or on a provider switch.
      yield* patchTask(task, { status: "usage_limited", reason: failure.resetAt ?? null });
    } else if (run.status !== "completed") {
      yield* patchTask(task, { status: "failed", reason: run.status });
      yield* resumeParent({ ...task, status: "failed" });
    } else if (runner !== undefined && runner !== task.owner_id) {
      // Handed to someone else while it ran: the new owner takes it, nothing is posted.
      yield* patchTask(task, {
        status: "queued",
        reason: null,
        revision: task.revision + 1,
        result_text: null,
      });
    } else if ((yield* unsettledChildren(task.task_id)).length > 0) {
      yield* patchTask(task, { status: "waiting", reason: null });
    } else {
      const answer =
        task.result_text?.trim() || (yield* answerOf(run.threadId, run.id)) || NO_ANSWER;
      if (yield* isDelivery(task, answer)) {
        yield* sql`
          UPDATE assistant_group_tasks SET undelivered_hops = 0 WHERE task_id = ${task.root_id}`;
      }
      yield* insertMessage({
        teamId: task.team_id,
        author: "assistant",
        assistantId: task.owner_id,
        kind: "message",
        text: answer,
        replyTo: task.request_message_id,
        taskId: task.task_id,
        requestId: task.request_id,
      });
      const done = yield* patchTask(task, {
        status: "completed",
        reason: null,
        result_text: answer,
      });
      yield* resumeParent(done);
    }
  });

  /**
   * One notice per wait in the request's block, written by the member whose conversation waits;
   * once nothing waits on it any more (answered anywhere) the notice is marked resolved, not removed.
   */
  const syncWaiting = Effect.fn("AssistantGroups.syncWaiting")(function* (requestId: string) {
    const request = yield* getMessage(requestId);
    if (request === undefined) return;
    const members = yield* sql<{ readonly thread_id: string; readonly assistant_id: string }>`
      SELECT thread_id, assistant_id FROM assistant_group_request_threads
      WHERE request_id = ${requestId}`;
    const names = new Map(
      (yield* assistantRows(members.map((row) => row.assistant_id))).map((row) => [
        row.assistant_id,
        row.name,
      ]),
    );
    const ownerOf = new Map(members.map((row) => [row.thread_id, row.assistant_id]));
    const waits = yield* threadsWaitingOnUser(
      members.map((row) => ({
        threadId: row.thread_id as ThreadId,
        agent: names.get(row.assistant_id) ?? "A member",
      })),
    ).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
    );
    const posted = yield* sql<MessageRow>`
      SELECT * FROM assistant_group_messages
      WHERE request_id = ${requestId} AND wait_key IS NOT NULL`;
    const known = new Set(posted.map((row) => row.wait_key));
    for (const wait of waits) {
      if (known.has(wait.key)) continue;
      yield* insertMessage({
        teamId: request.team_id,
        author: "assistant",
        assistantId: ownerOf.get(wait.threadId) ?? null,
        kind: "notice",
        text: [
          wait.title,
          wait.context,
          wait.options.length === 0 ? "" : `Options: ${wait.options.join(" · ")}`,
        ]
          .filter((part) => part.trim() !== "")
          .join("\n\n"),
        requestId,
        wait,
      });
    }
    const live = new Set(waits.map((wait) => wait.key));
    for (const row of posted) {
      if (row.wait_resolved_at !== null || live.has(row.wait_key!)) continue;
      const resolved = yield* sql<MessageRow>`
        UPDATE assistant_group_messages SET wait_resolved_at = ${yield* nowIso}
        WHERE message_id = ${row.message_id} AND wait_resolved_at IS NULL RETURNING *`;
      if (resolved[0] !== undefined) yield* publishMessage(resolved[0]);
    }
  });

  const syncWaitingThread: AssistantGroups["Service"]["syncWaitingThread"] = Effect.fn(
    "AssistantGroups.syncWaitingThread",
  )(
    function* (threadId) {
      if (!isAssistantGroupThreadId(threadId)) return;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const owner = yield* threadRowOf(threadId);
          if (owner?.request_id == null) return;
          yield* syncWaiting(owner.request_id);
        }),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant groups: a waiting notice could not be synced", { cause }),
        ),
      ),
  );

  const handleRunEvent: AssistantGroups["Service"]["handleRunEvent"] = Effect.fn(
    "AssistantGroups.handleRunEvent",
  )(
    function* (event) {
      if (event.type === "runtime-request.updated") return yield* syncWaitingThread(event.threadId);
      if (event.type !== "run.created" && event.type !== "run.updated") return;
      if (!isAssistantGroupThreadId(event.payload.threadId)) return;
      if (
        parseTaskMessageId(event.payload.userMessageId) === null &&
        !isLimitContinuation(event.payload)
      )
        return;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* finishRun(event.payload);
          const owner = yield* threadRowOf(event.payload.threadId);
          if (owner === undefined) return;
          // Before the pump, so the thread's next task starts on the new provider.
          if (ENDED_RUN.has(event.payload.status)) yield* applyPendingModel(owner.thread_id);
          // A request that ended while this run was still stopping settles now that it has.
          if (ENDED_RUN.has(event.payload.status)) yield* closeRequestIfDone(owner.request_id);
          yield* pump(owner.team_id);
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant group reactor failed", { eventType: event.type, cause }),
        ),
      ),
  );

  const taskAction: AssistantGroups["Service"]["taskAction"] = Effect.fn(
    "AssistantGroups.taskAction",
  )(function* (input) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const task = yield* requireTask(input.taskId);
          const team = yield* loadTeam(task.team_id);
          const status = task.status as AssistantGroupTaskStatus;
          const wrong = () => invalid(`A ${status} task cannot be ${input.action}ed that way.`);
          switch (input.action) {
            case "stop": {
              if (!ACTIVE.includes(status)) return yield* wrong();
              const stopped = yield* pauseBranch(task, "stopped");
              yield* pump(team.id);
              return (yield* wireTasks([stopped]))[0]!;
            }
            case "resume":
            case "reassign": {
              if (status !== "paused" && status !== "failed") return yield* wrong();
              if (team.archivedAt !== null) {
                return yield* assistantError("archived", "This group is archived.");
              }
              const members = yield* activeMembers(team);
              const ownerId = input.action === "reassign" ? input.ownerId : task.owner_id;
              if (ownerId === undefined)
                return yield* invalid("Choose the member that takes the task.");
              const owner = members.find((member) => member.assistant_id === ownerId);
              if (owner === undefined) {
                return yield* invalid(
                  input.action === "reassign"
                    ? "That member is not in the group."
                    : "Its member is no longer in the group; reassign it.",
                );
              }
              yield* refuseOutsideProject(team, owner, task.request_id ?? task.request_message_id);
              const next = yield* requeue(task, ownerId);
              yield* pump(team.id);
              return (yield* wireTasks([(yield* getTask(next.task_id)) ?? next]))[0]!;
            }
            case "cancel": {
              if (status !== "paused" && status !== "failed") return yield* wrong();
              const open = yield* sql<TaskRow>`
              SELECT * FROM assistant_group_tasks
              WHERE root_id = ${task.root_id} AND status IN ${sql.in(OPEN)}`;
              let cancelled = task;
              for (const row of open) {
                yield* haltTask(row);
                const done = yield* patchTask(row, { status: "cancelled", reason: null });
                if (row.task_id === task.task_id) cancelled = done;
              }
              yield* pump(team.id);
              return (yield* wireTasks([cancelled]))[0]!;
            }
          }
        }),
      )
      .pipe(storage);
  });

  const callerOf = Effect.fn("AssistantGroups.callerOf")(function* (threadId: ThreadId) {
    const row = yield* threadRowOf(threadId);
    if (row === undefined) {
      return yield* invalid("This tool only works inside a group task.");
    }
    return row;
  });

  /** The caller's team (open for work) and the task it is running. */
  const callerTask = Effect.fn("AssistantGroups.callerTask")(function* (threadId: ThreadId) {
    const caller = yield* callerOf(threadId);
    const team = yield* loadTeam(caller.team_id);
    if (team.archivedAt !== null)
      return yield* assistantError("archived", "This group is archived.");
    const task = yield* runningTaskOf(caller);
    if (task === undefined) return yield* invalid("No task of yours is running in this group.");
    return { caller, team, task };
  });

  const findMember = Effect.fn("AssistantGroups.findMember")(function* (
    team: AssistantTeam,
    handle: string,
  ) {
    const wanted = handle.trim().replace(/^@/, "").toLowerCase();
    const member = (yield* activeMembers(team)).find(
      (row) => row.handle === wanted || row.name.toLowerCase().replace(/\s+/g, "") === wanted,
    );
    return member ?? (yield* invalid(`There is no member @${wanted} in this group.`));
  });

  const rootOf = (task: TaskRow) =>
    task.root_id === task.task_id ? Effect.succeed(task) : requireTask(task.root_id);

  /**
   * Counts a hand-off on the request's root. Past either cap the hand-off is refused and the whole
   * request stops, running turns included, until the user acts on it; the chat says which cap.
   */
  const chargeHandoff = Effect.fn("AssistantGroups.chargeHandoff")(function* (
    team: AssistantTeam,
    task: TaskRow,
  ) {
    const root = yield* rootOf(task);
    const reason =
      root.undelivered_hops >= ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY
        ? "no_delivery"
        : root.hops >= ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION
          ? "handoff_limit"
          : null;
    if (reason === null) {
      yield* sql`
        UPDATE assistant_group_tasks
        SET hops = hops + 1, undelivered_hops = undelivered_hops + 1
        WHERE task_id = ${root.task_id}`;
      return;
    }
    yield* pauseBranch(root, reason);
    yield* insertMessage({
      teamId: team.id,
      author: "assistant",
      assistantId: task.owner_id,
      kind: "notice",
      text: HANDOFF_PAUSES[reason].notice,
      replyTo: task.request_message_id,
      requestId: task.request_id,
    });
    yield* pump(team.id);
    return yield* invalid(HANDOFF_PAUSES[reason].refusal);
  });

  /** Work in a request goes only to a member that may work in its project. */
  const refuseOutsideProject = Effect.fn("AssistantGroups.refuseOutsideProject")(function* (
    team: AssistantTeam,
    member: AssistantRow,
    requestId: string | null,
  ) {
    const projectId =
      requestId === null ? null : ((yield* getMessage(requestId))?.project_id ?? null);
    if (!worksIn(member, team, projectId)) {
      return yield* invalid(
        `${member.name} cannot work in this request's project; give it to a member who does.`,
      );
    }
  });

  const memberTools: AssistantGroups["Service"]["member"] = {
    history: Effect.fn("AssistantGroups.member.history")(function* (input) {
      const caller = yield* callerOf(input.callerThreadId);
      // A request's thread reads only that request; an older group-wide thread reads the chat.
      const rows =
        caller.request_id === null
          ? yield* sql<MessageRow>`
              SELECT * FROM assistant_group_messages
              WHERE team_id = ${caller.team_id} AND seq < ${input.beforeSeq ?? Number.MAX_SAFE_INTEGER}
                AND seq > ${input.beforeSeq === undefined ? yield* boundaryOf(caller.team_id) : 0}
              ORDER BY seq DESC LIMIT ${ASSISTANT_GROUP_PAGE_SIZE + 1}`
          : yield* sql<MessageRow>`
              SELECT * FROM assistant_group_messages
              WHERE request_id = ${caller.request_id}
                AND seq < ${input.beforeSeq ?? Number.MAX_SAFE_INTEGER}
              ORDER BY seq DESC LIMIT ${ASSISTANT_GROUP_PAGE_SIZE + 1}`;
      const messages: AssistantGroupMessage[] = [];
      let used = 0;
      let more = rows.length > ASSISTANT_GROUP_PAGE_SIZE;
      for (const row of rows.slice(0, ASSISTANT_GROUP_PAGE_SIZE)) {
        const cut = { ...row, text: clip(row.text, HISTORY_MESSAGE_CHARS) };
        if (used + cut.text.length > HISTORY_PAGE_CHARS && messages.length > 0) {
          more = true;
          break;
        }
        used += cut.text.length;
        messages.unshift(toMessage(cut));
      }
      return { messages, hasMore: more };
    }, storage),
    assign: Effect.fn("AssistantGroups.member.assign")(function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const { team, task } = yield* callerTask(input.callerThreadId);
          if (task.kind === "reply") return yield* invalid(REPLY_TASK_REFUSAL);
          const target = yield* findMember(team, input.member);
          if (target.assistant_id === task.owner_id) {
            return yield* invalid("Do not assign a task to yourself.");
          }
          yield* refuseOutsideProject(team, target, task.request_id);
          // A repeat of the same assignment lands on the same task.
          const repeat = yield* sql<TaskRow>`
              SELECT * FROM assistant_group_tasks
              WHERE parent_id = ${task.task_id} AND kind = 'child' AND owner_id = ${target.assistant_id}
                AND instruction = ${input.instruction} AND revision = 1`;
          if (repeat[0] !== undefined) {
            return {
              taskId: repeat[0].task_id as AssistantGroupTaskId,
              status: repeat[0].status as AssistantGroupTaskStatus,
            };
          }
          yield* chargeHandoff(team, task);
          const expected = clip((input.expectedResult ?? "").trim(), EXPECTED_RESULT_CHARS);
          const sourceSeqs = [...new Set(input.sourceSeqs ?? [])]
            .filter((seq) => Number.isInteger(seq) && seq > 0)
            .slice(0, QUOTED_MESSAGES);
          const child = yield* insertTask({
            teamId: team.id,
            rootId: task.root_id,
            parentId: task.task_id,
            kind: "child",
            requestMessageId: task.request_message_id,
            requestId: task.request_id,
            ownerId: target.assistant_id,
            instruction: input.instruction,
            status: "queued",
            expectedResult: expected === "" ? null : expected,
            sourceSeqs,
            resources: normalizeResources(input.resources ?? []),
          });
          yield* pump(team.id);
          const current = (yield* getTask(child.task_id)) ?? child;
          return {
            taskId: current.task_id as AssistantGroupTaskId,
            status: current.status as AssistantGroupTaskStatus,
          };
        }),
      );
    }, storage),
    transfer: Effect.fn("AssistantGroups.member.transfer")(function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const { team, task } = yield* callerTask(input.callerThreadId);
          if (task.kind === "reply") return yield* invalid(REPLY_TASK_REFUSAL);
          const target = yield* findMember(team, input.member);
          const settled = (row: TaskRow) => ({
            taskId: row.task_id as AssistantGroupTaskId,
            status: row.status as AssistantGroupTaskStatus,
          });
          if (target.assistant_id === task.owner_id) return settled(task);
          yield* refuseOutsideProject(team, target, task.request_id);
          yield* chargeHandoff(team, task);
          const from = yield* nameOf(task.owner_id);
          // The new owner takes over when the caller's run ends.
          const moved = yield* patchTask(task, {
            owner_id: target.assistant_id,
            followup: handOverText(from, input.note),
          });
          return settled((yield* getTask(moved.task_id)) ?? moved);
        }),
      );
    }, storage),
    reply: Effect.fn("AssistantGroups.member.reply")(function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const { team, caller, task } = yield* callerTask(input.callerThreadId);
          if (task.kind === "reply") return yield* invalid(REPLY_TASK_REFUSAL);
          if (Array.from(input.text).length > ASSISTANT_GROUP_REPLY_MAX_CHARS) {
            return yield* invalid(
              `Keep the question under ${ASSISTANT_GROUP_REPLY_MAX_CHARS} characters.`,
            );
          }
          const target =
            input.seq === undefined
              ? yield* getMessage(input.messageId ?? "")
              : (yield* sql<MessageRow>`
                  SELECT * FROM assistant_group_messages
                  WHERE team_id = ${team.id} AND seq = ${input.seq}`)[0];
          if (
            target === undefined ||
            target.team_id !== team.id ||
            target.author !== "assistant" ||
            target.kind !== "message" ||
            target.assistant_id === null ||
            (task.request_id !== null && target.request_id !== task.request_id)
          ) {
            return yield* invalid("Reply to a message a member wrote in this request.");
          }
          if (target.assistant_id === caller.assistant_id) {
            return yield* invalid("You cannot ask yourself.");
          }
          const members = yield* activeMembers(team);
          const asked = members.find((member) => member.assistant_id === target.assistant_id);
          if (asked === undefined) {
            return yield* invalid("That member is no longer in the group.");
          }
          yield* refuseOutsideProject(team, asked, task.request_id);
          const root = yield* rootOf(task);
          const accepted = (taskId: string): GroupToolResult => ({
            accepted: true,
            message: `Asked. The answer arrives as a new message from the member (task ${taskId}).`,
          });
          // A repeat of the same question lands on the same reply.
          const repeat = yield* sql<TaskRow>`
              SELECT t.* FROM assistant_group_tasks t
              JOIN assistant_group_messages m ON m.message_id = t.request_message_id
              WHERE t.parent_id = ${task.task_id} AND t.kind = 'reply'
                AND m.reply_to = ${target.message_id} AND m.text = ${input.text}`;
          if (repeat[0] !== undefined) return accepted(repeat[0].task_id);
          const used = (yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM assistant_group_tasks
              WHERE kind = 'reply' AND request_id = ${task.request_id ?? root.request_message_id}`)[0]!
            .n;
          if (used >= ASSISTANT_GROUP_REPLY_LIMIT) {
            return { accepted: false, message: REPLY_LIMIT_MESSAGE };
          }
          const asker = yield* nameOf(caller.assistant_id);
          const question = yield* insertMessage({
            teamId: team.id,
            author: "assistant",
            assistantId: caller.assistant_id,
            kind: "message",
            text: input.text,
            replyTo: target.message_id,
            requestId: task.request_id,
          });
          const reply = yield* insertTask({
            teamId: team.id,
            rootId: task.root_id,
            parentId: task.task_id,
            kind: "reply",
            requestMessageId: question.message_id,
            requestId: task.request_id,
            ownerId: target.assistant_id,
            instruction: `Question from ${asker} (a teammate, not the user): ${input.text}`,
            status: "queued",
          });
          yield* pump(team.id);
          return accepted(reply.task_id);
        }),
      );
    }, storage),
    result: Effect.fn("AssistantGroups.member.result")(function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const { task } = yield* callerTask(input.callerThreadId);
          const pending = yield* sql<TaskRow>`
              SELECT * FROM assistant_group_tasks
              WHERE parent_id = ${task.task_id} AND kind = 'reply'
                AND status NOT IN ${sql.in(SETTLED)}`;
          if (pending.length > 0) return { accepted: false, message: RESULT_WAITS_FOR_REPLY };
          yield* patchTask(task, { result_text: clip(input.text, RESULT_MAX_CHARS) });
          return { accepted: true, message: "Your answer is posted when this task ends." };
        }),
      );
    }, storage),
    cancel: Effect.fn("AssistantGroups.member.cancel")(function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const { team, task } = yield* callerTask(input.callerThreadId);
          const target = yield* getTask(input.taskId);
          const parent = target?.parent_id == null ? undefined : yield* getTask(target.parent_id);
          // Only a task the caller gave: its parent is a task the caller owns.
          if (
            target === undefined ||
            target.team_id !== team.id ||
            target.request_id !== task.request_id ||
            parent === undefined ||
            parent.owner_id !== task.owner_id
          ) {
            return yield* invalid("You can only cancel a task you assigned.");
          }
          if (target.status === "cancelled")
            return { accepted: true, message: "Already cancelled." };
          if (target.status === "completed") {
            return { accepted: false, message: "That task is already completed." };
          }
          const reason = clip(input.reason.trim(), CANCEL_REASON_CHARS);
          const open = [target, ...(yield* descendants(target))].filter((row) =>
            OPEN.includes(row.status as AssistantGroupTaskStatus),
          );
          let cancelled = target;
          for (const row of open) {
            yield* haltTask(row);
            const done = yield* patchTask(row, {
              status: "cancelled",
              reason: row === target && reason !== "" ? reason : null,
            });
            if (row === target) cancelled = done;
          }
          yield* resumeParent(cancelled);
          yield* pump(team.id);
          return { accepted: true, message: "Cancelled." };
        }),
      );
    }, storage),
    routineScope: Effect.fn("AssistantGroups.member.routineScope")(function* (input) {
      const { team, task } = yield* callerTask(input.callerThreadId);
      const request = yield* getMessage((yield* rootOf(task)).request_message_id);
      return { teamId: team.id, askedByUser: request?.author === "user" };
    }, storage),
  };

  const agentPost: AssistantGroups["Service"]["agentPost"] = Effect.fn("AssistantGroups.agentPost")(
    function* (input) {
      if (isAssistantGroupThreadId(input.callerThreadId)) {
        return yield* invalid("You are inside a group task: use assign or transfer.");
      }
      const wanted = input.group.trim();
      const matches = yield* sql<AssistantTeamRow>`
        SELECT * FROM assistant_teams
        WHERE team_id = ${wanted} OR LOWER(name) = ${wanted.toLowerCase()}`;
      const byId = matches.find((row) => row.team_id === wanted);
      if (byId === undefined && matches.length > 1) {
        return yield* invalid("Several groups have that name; use the group id.");
      }
      const team = byId ?? matches[0];
      if (team === undefined) return yield* assistantError("not_found", "Group not found.");
      const wantedProject = input.project?.trim() ?? "";
      const group = toAssistantTeam(team);
      const projects = yield* groupProjects(group, yield* activeMembers(group));
      let projectId: ProjectId | undefined;
      if (wantedProject !== "") {
        const found = projects.filter(
          (project) =>
            project.id === wantedProject ||
            project.name.toLowerCase() === wantedProject.toLowerCase(),
        );
        if (found.length !== 1) {
          return yield* invalid(
            `Pick one of the group's projects: ${projects.map((project) => `${project.name} (${project.id})`).join(", ")}.`,
          );
        }
        projectId = found[0]!.id as ProjectId;
      }
      const outside = yield* projectScopeRefusal(Option.some(directory), {
        threadId: input.callerThreadId,
        projectId,
      });
      if (Option.isSome(outside)) return yield* invalid(outside.value);
      if (projectId === undefined) {
        const poster = yield* directory.forThread(input.callerThreadId);
        // A project assistant's work stays in its home project, when the group has it, unless it
        // names another of its own.
        const home = Option.isSome(poster) ? poster.value.assistant : undefined;
        if (
          home !== undefined &&
          assistantProjects(home, group) !== "all" &&
          projects.some((project) => project.id === home.projectId)
        ) {
          projectId = home.projectId;
        }
      }
      const assistantId = assistantIdFromThreadId(input.callerThreadId);
      const sender = assistantId === null ? [] : yield* assistantRows([assistantId]);
      const title = yield* inspectThread(input.callerThreadId);
      const label = title?.title ?? sender[0]?.name ?? "Another conversation";
      const paths = input.paths ?? [];
      const copied =
        paths.length === 0
          ? []
          : yield* copyTransfer({
              sharedDir: config.sharedDir,
              ownerId: assistantId ?? "agents",
              // The same call copies to the same folder, so a retry finds its files already there.
              transferId: `group:${team.team_id}:${sha256(`${input.callerThreadId}\0${input.text}\0${paths.join("\0")}`)}`,
              sender: {
                name: sender[0]?.name ?? label,
                handle: sender[0]?.handle ?? "",
              },
              recipients: [],
              paths,
            }).pipe(Effect.mapError((error) => assistantError("invalid", error.message)));
      const text = `${input.text}${transferText(copied)}`;
      if (input.clientRequestId === undefined) {
        // With no id from the caller, a repeat before anything new was said is the same post.
        const latest = (yield* sql<MessageRow>`
          SELECT * FROM assistant_group_messages
          WHERE team_id = ${team.team_id} AND kind = 'message' ORDER BY seq DESC LIMIT 1`)[0];
        if (
          latest?.author === "agent" &&
          latest.author_label === label &&
          latest.assistant_id === assistantId &&
          latest.text === text
        ) {
          const tasks = yield* tasksOfMessage(latest.message_id);
          return { message: toMessage(latest), tasks: yield* wireTasks(tasks) };
        }
      }
      return yield* post(
        {
          teamId: team.team_id as AssistantTeamId,
          text: text as AssistantGroupsPostInput["text"],
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
          ...(projectId === undefined ? {} : { projectId }),
        },
        { kind: "agent", assistantId: assistantId as AssistantId | null, label },
      );
    },
    storage,
  );

  const announce: AssistantGroups["Service"]["announce"] = Effect.fn("AssistantGroups.announce")(
    function* (input) {
      yield* teamRow(input.teamId);
      const done = yield* sql`
        SELECT 1 FROM assistant_group_messages
        WHERE team_id = ${input.teamId} AND client_request_id = ${input.clientRequestId}`;
      if (done.length > 0) return;
      const assistantId = assistantIdFromThreadId(input.callerThreadId);
      const sender = assistantId === null ? [] : yield* assistantRows([assistantId]);
      const title = yield* inspectThread(input.callerThreadId);
      const who = sender[0]?.name ?? title?.title ?? "An agent";
      yield* insertMessage({
        teamId: input.teamId,
        author: sender[0] === undefined ? "agent" : "assistant",
        assistantId: sender[0]?.assistant_id ?? null,
        authorLabel: sender[0] === undefined ? who : null,
        kind: "change",
        text: `${who} ${input.text}`,
        clientRequestId: input.clientRequestId,
      });
    },
    storage,
  );

  const announceRoutine: AssistantGroups["Service"]["announceRoutine"] = Effect.fn(
    "AssistantGroups.announceRoutine",
  )(function* (input) {
    yield* teamRow(input.teamId);
    const done = yield* sql`
      SELECT 1 FROM assistant_group_messages
      WHERE team_id = ${input.teamId} AND client_request_id = ${input.clientRequestId}`;
    if (done.length > 0) return;
    yield* insertMessage({
      teamId: input.teamId,
      author: "routine",
      authorLabel: input.label,
      kind: "change",
      text: input.text,
      clientRequestId: input.clientRequestId,
    });
  }, storage);

  /** Members that left lose their open work and their thread; an archived group pauses everything. */
  const reconcileTeam = Effect.fn("AssistantGroups.reconcileTeam")(function* (team: AssistantTeam) {
    const legacy = yield* sql<ThreadRow>`
      SELECT team_id, assistant_id, thread_id, seen_seq, NULL AS request_id
      FROM assistant_group_threads WHERE team_id = ${team.id}`;
    // A request's threads are already archived once it ends; only open ones matter here.
    const open = yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_request_threads r
      WHERE r.team_id = ${team.id} AND EXISTS (
        SELECT 1 FROM assistant_group_tasks t
        WHERE t.request_id = r.request_id AND t.status IN ${sql.in(OPEN)})`;
    const rows = [...legacy, ...open];
    const gone = new Set(
      rows
        .map((row) => row.assistant_id)
        .filter((id) => !team.memberIds.includes(id as AssistantId)),
    );
    for (const assistantId of gone) {
      const tasks = yield* sql<TaskRow>`
        SELECT * FROM assistant_group_tasks
        WHERE team_id = ${team.id} AND owner_id = ${assistantId} AND status IN ${sql.in(ACTIVE)}`;
      for (const task of tasks) yield* pauseTask(task, "member_removed");
    }
    yield* archiveThreads(rows.filter((row) => gone.has(row.assistant_id)));
    if (team.archivedAt !== null) {
      const open = yield* sql<TaskRow>`
        SELECT * FROM assistant_group_tasks
        WHERE team_id = ${team.id} AND status IN ${sql.in(ACTIVE)}`;
      for (const task of open) yield* pauseTask(task, "group_archived");
    }
    // A renamed group or member renames the hidden threads, which clients show as "Ada · Group".
    const names = new Map((yield* activeMembers(team)).map((row) => [row.assistant_id, row.name]));
    const requestTitles = new Map(
      (open.length === 0
        ? []
        : yield* sql<MessageRow>`
            SELECT * FROM assistant_group_messages
            WHERE message_id IN ${sql.in([...new Set(open.map((row) => row.request_id!))])}`
      ).map((row) => [row.message_id, row.title ?? titleFromText(row.text)]),
    );
    for (const row of rows) {
      const name = names.get(row.assistant_id);
      if (name === undefined) continue;
      const requestTitle = row.request_id === null ? undefined : requestTitles.get(row.request_id);
      const title =
        requestTitle === undefined
          ? `${name} · ${team.name}`
          : `${name} · ${team.name} · ${clip(requestTitle, 60)}`;
      const thread = yield* inspectThread(row.thread_id as ThreadId);
      if (thread === undefined || thread.deletedAt !== null || thread.title === title) continue;
      yield* engine
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(
            `assistant-group-title:${team.id}:${row.assistant_id}:${yield* newId("t")}`,
          ),
          threadId: row.thread_id as ThreadId,
          title,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("assistant groups: thread title not updated", { cause }),
          ),
        );
    }
    yield* pump(team.id);
  });

  const deleteThreads = Effect.fn("AssistantGroups.deleteThreads")(function* (
    rows: ReadonlyArray<ThreadRow>,
  ) {
    for (const row of rows) {
      const thread = yield* inspectThread(row.thread_id as ThreadId);
      if (thread !== undefined && thread.deletedAt === null) {
        yield* dispatchLifecycle(
          `assistant-group-delete:${row.thread_id}`,
          "thread.delete",
          row.thread_id as ThreadId,
        );
      }
    }
  });

  const groupRequestThreads = (teamId: string) =>
    sql<ThreadRow>`SELECT * FROM assistant_group_request_threads WHERE team_id = ${teamId}`;

  /**
   * The group's chat, tasks, summary and the files of its messages; nothing else of the group. The
   * members keep their requests' conversations, settled and no longer the group's.
   */
  const clearChat = Effect.fn("AssistantGroups.clearChat")(function* (teamId: string) {
    yield* settleThreads(yield* groupRequestThreads(teamId));
    yield* sql`
      INSERT OR IGNORE INTO assistant_kept_threads (thread_id, assistant_id)
      SELECT thread_id, assistant_id FROM assistant_group_request_threads WHERE team_id = ${teamId}`;
    yield* sql`DELETE FROM assistant_group_request_threads WHERE team_id = ${teamId}`;
    const owned = (yield* sql<MessageRow>`
      SELECT * FROM assistant_group_messages WHERE team_id = ${teamId}`).flatMap(attachmentsOf);
    yield* cleanup
      .cleanupAttachments(owned.map((attachment) => attachment.id))
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("assistant groups: attachments were not deleted", { teamId, cause }),
        ),
      );
    yield* sql`DELETE FROM assistant_group_messages WHERE team_id = ${teamId}`;
    yield* sql`DELETE FROM assistant_group_tasks WHERE team_id = ${teamId}`;
    yield* sql`DELETE FROM assistant_group_summaries WHERE team_id = ${teamId}`;
  });

  /** The group is gone: its work stops, its threads, chat and schedules go. */
  const removeGroup = Effect.fn("AssistantGroups.removeGroup")(function* (teamId: string) {
    const inFlight = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks
      WHERE team_id = ${teamId} AND status IN ('running', 'usage_limited')`;
    for (const task of inFlight) yield* haltTask(task);
    yield* deleteThreads(
      yield* sql<ThreadRow>`SELECT * FROM assistant_group_threads WHERE team_id = ${teamId}`,
    );
    yield* deleteThreads(yield* groupRequestThreads(teamId));
    yield* sql`DELETE FROM assistant_group_request_threads WHERE team_id = ${teamId}`;
    yield* scheduledTasks
      .deleteForTeam(teamId)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("assistant groups: schedules were not deleted", { teamId, cause }),
        ),
      );
    yield* clearChat(teamId);
    yield* sql`DELETE FROM assistant_group_threads WHERE team_id = ${teamId}`;
  });

  /** A deleted assistant: its group threads and kept conversations go; its tasks wait for a new owner. */
  const removeAssistant = Effect.fn("AssistantGroups.removeAssistant")(function* (
    assistantId: string,
  ) {
    const rows = yield* sql<ThreadRow>`
      SELECT team_id, assistant_id, thread_id, seen_seq, NULL AS request_id
      FROM assistant_group_threads WHERE assistant_id = ${assistantId}
      UNION ALL
      SELECT team_id, assistant_id, thread_id, seen_seq, request_id
      FROM assistant_group_request_threads WHERE assistant_id = ${assistantId}
      UNION ALL
      SELECT '' AS team_id, assistant_id, thread_id, 0 AS seen_seq, NULL AS request_id
      FROM assistant_kept_threads WHERE assistant_id = ${assistantId}`;
    const open = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks
      WHERE owner_id = ${assistantId} AND status IN ${sql.in(ACTIVE)}`;
    for (const task of open) yield* pauseTask(task, "member_removed");
    yield* deleteThreads(rows);
    yield* sql`DELETE FROM assistant_group_threads WHERE assistant_id = ${assistantId}`;
    yield* sql`DELETE FROM assistant_group_request_threads WHERE assistant_id = ${assistantId}`;
    yield* sql`DELETE FROM assistant_kept_threads WHERE assistant_id = ${assistantId}`;
  });

  const handleAssistantEvent: AssistantGroups["Service"]["handleAssistantEvent"] = Effect.fn(
    "AssistantGroups.handleAssistantEvent",
  )(
    function* (event) {
      switch (event.type) {
        case "teamUpserted":
          return yield* lock.withPermits(1)(
            reconcileTeam(event.team).pipe(Effect.andThen(routePending(event.team))),
          );
        case "teamRemoved":
          return yield* lock.withPermits(1)(removeGroup(event.teamId));
        case "removed":
          return yield* lock.withPermits(1)(removeAssistant(event.assistantId));
        case "upserted": {
          const teams = (yield* sql<AssistantTeamRow>`SELECT * FROM assistant_teams`)
            .map(toAssistantTeam)
            .filter((team) => team.memberIds.includes(event.assistant.id));
          for (const team of teams) yield* lock.withPermits(1)(reconcileTeam(team));
          return;
        }
        default:
          return;
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant groups: change not applied", {
            eventType: event.type,
            cause,
          }),
        ),
      ),
  );

  const reconcile: AssistantGroups["Service"]["reconcile"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const teams = (yield* sql<AssistantTeamRow>`SELECT * FROM assistant_teams`).map(
          toAssistantTeam,
        );
        for (const team of teams) yield* reconcileTeam(team);
        // What a member's conversation started waiting on, or stopped, while the server was down.
        const waiting = yield* sql<{ readonly request_id: string }>`
          SELECT rt.request_id FROM assistant_group_request_threads rt
          WHERE EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests r
              WHERE r.thread_id = rt.thread_id AND r.status = 'pending')
            OR EXISTS (SELECT 1 FROM decisions d
              WHERE d.from_thread_id = rt.thread_id AND d.status = 'open')
          UNION SELECT request_id FROM assistant_group_messages
          WHERE wait_key IS NOT NULL AND wait_resolved_at IS NULL AND request_id IS NOT NULL`;
        // One bad request never keeps the others' notices from being synced.
        for (const row of waiting) {
          yield* syncWaiting(row.request_id).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("assistant groups: a waiting notice could not be synced", {
                requestId: row.request_id,
                cause,
              }),
            ),
          );
        }
        const known = new Set<string>(teams.map((team) => team.id));
        const stored = yield* sql<{ readonly team_id: string }>`
          SELECT team_id FROM assistant_group_threads
          UNION SELECT team_id FROM assistant_group_request_threads
          UNION SELECT team_id FROM assistant_group_tasks
          UNION SELECT team_id FROM assistant_group_messages`;
        for (const row of stored) if (!known.has(row.team_id)) yield* removeGroup(row.team_id);
        const owners = yield* sql<{ readonly assistant_id: string }>`
          SELECT assistant_id FROM assistant_group_threads
          UNION SELECT assistant_id FROM assistant_group_request_threads`;
        const existing = new Set(
          (yield* assistantRows(owners.map((row) => row.assistant_id))).map(
            (row) => row.assistant_id,
          ),
        );
        for (const row of owners)
          if (!existing.has(row.assistant_id)) yield* removeAssistant(row.assistant_id);
        // A message the lead was still routing when the server stopped is routed again.
        for (const team of teams) yield* routePending(team);
      }),
    )
    .pipe(quietly("reconcile"));

  const start: AssistantGroups["Service"]["start"] = Effect.gen(function* () {
    const changes = yield* assistants.subscribeChanges;
    const settingsChanges = yield* serverSettings.subscribeChanges;
    let previousSettings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      Stream.runForEach(settingsChanges, (next) => {
        const changed = projectModelChanges(previousSettings, next);
        previousSettings = next;
        return followProjectModels(changed);
      }).pipe(quietly("settings stream")),
    );
    yield* forkParked(
      reconcile.pipe(
        Effect.andThen(Stream.runForEach(Stream.fromSubscription(changes), handleAssistantEvent)),
        quietly("change stream"),
      ),
    );
  });

  const subscribe: AssistantGroups["Service"]["subscribe"] = (teamId) =>
    Stream.unwrap(
      // Subscribe before the snapshot while holding the writers' lock, so no change falls between.
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            yield* teamRow(teamId);
            const subscription = yield* PubSub.subscribe(events);
            const page = yield* readPage(teamId, undefined);
            return Stream.concat(
              Stream.succeed<AssistantGroupsEvent>({ type: "snapshot", ...page }),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((item) => item.teamId === teamId),
                Stream.map((item) => item.event),
              ),
            );
          }),
        )
        .pipe(storage),
    );

  const markRead: AssistantGroups["Service"]["markRead"] = Effect.fn("AssistantGroups.markRead")(
    function* (input) {
      yield* teamRow(input.teamId);
      const target =
        input.unread === true
          ? ((yield* sql<{ readonly seq: number | null }>`
              SELECT MAX(seq) AS seq FROM assistant_group_messages
              WHERE team_id = ${input.teamId} AND author != 'user'
                AND kind NOT IN ('routing', 'boundary', 'change')`)[0]?.seq ?? 1) - 1
          : (input.readSeq ?? Number.MAX_SAFE_INTEGER);
      const rows = yield* sql<{ readonly read_seq: number }>`
        UPDATE assistant_teams SET read_seq = MIN(${target}, COALESCE(
          (SELECT MAX(seq) FROM assistant_group_messages m WHERE m.team_id = assistant_teams.team_id), 0))
        WHERE team_id = ${input.teamId} RETURNING read_seq`;
      yield* assistants.refreshTeamChat(input.teamId);
      return { readSeq: rows[0]!.read_seq };
    },
    storage,
  );

  const conversation: AssistantGroups["Service"]["conversation"] = Effect.fn(
    "AssistantGroups.conversation",
  )(function* (input) {
    const { teamId } = input;
    const ensureIdle = Effect.gen(function* () {
      const open = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM assistant_group_tasks
        WHERE team_id = ${teamId} AND status IN ${sql.in(ACTIVE)}`;
      if ((open[0]?.n ?? 0) > 0) {
        return yield* invalid("The group is working. Stop its tasks first.");
      }
    });
    const publishPage = Effect.gen(function* () {
      const page = yield* readPage(teamId, undefined);
      yield* PubSub.publish(events, { teamId, event: { type: "snapshot", ...page } });
      yield* assistants.refreshTeamChat(teamId);
    });
    yield* teamRow(teamId);
    if (input.action === "compact") {
      yield* ensureIdle;
      const boundary = yield* boundaryOf(teamId);
      const fresh = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM assistant_group_messages
        WHERE team_id = ${teamId} AND seq > ${boundary} AND kind = 'message'`;
      if ((fresh[0]?.n ?? 0) === 0) return yield* invalid("There is nothing to compact.");
      // The summary is written before the boundary, so a failure leaves the chat as it was.
      const done = yield* summarize(teamId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant groups: compact failed", { teamId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (!done) return yield* invalid("Could not summarize the chat. Try again in a moment.");
    }
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        switch (input.action) {
          case "new":
          case "compact":
            yield* ensureIdle;
            if (input.action === "new") {
              yield* sql`DELETE FROM assistant_group_summaries WHERE team_id = ${teamId}`;
            }
            yield* insertMessage({
              teamId,
              author: "user",
              kind: "boundary",
              text: input.action,
            });
            return;
          case "undo": {
            const latest = (yield* sql<MessageRow>`
              SELECT * FROM assistant_group_messages WHERE team_id = ${teamId}
              ORDER BY seq DESC LIMIT 1`)[0];
            if (latest === undefined || latest.kind !== "boundary") {
              return yield* invalid("Only a boundary with nothing after it can be undone.");
            }
            yield* sql`DELETE FROM assistant_group_messages WHERE message_id = ${latest.message_id}`;
            // The next message reuses this number, so nothing may count it as seen already.
            yield* sql`
              UPDATE assistant_group_threads SET seen_seq = MIN(seen_seq, ${latest.seq - 1})
              WHERE team_id = ${teamId}`;
            yield* sql`
              UPDATE assistant_group_request_threads SET seen_seq = MIN(seen_seq, ${latest.seq - 1})
              WHERE team_id = ${teamId}`;
            yield* sql`
              UPDATE assistant_teams SET read_seq = MIN(read_seq, ${latest.seq - 1})
              WHERE team_id = ${teamId}`;
            return yield* publishPage;
          }
          case "clear":
            yield* ensureIdle;
            yield* clearChat(teamId);
            yield* sql`UPDATE assistant_group_threads SET seen_seq = 0 WHERE team_id = ${teamId}`;
            yield* sql`UPDATE assistant_teams SET read_seq = 0 WHERE team_id = ${teamId}`;
            return yield* publishPage;
        }
      }),
    );
    return { teamId: input.teamId };
  }, storage);

  const history: AssistantGroups["Service"]["history"] = Effect.fn("AssistantGroups.history")(
    function* (input) {
      yield* teamRow(input.teamId);
      return yield* readPage(input.teamId, input.beforeSeq);
    },
    storage,
  );

  return AssistantGroups.of({
    subscribe,
    history,
    post,
    taskAction,
    markRead,
    conversation,
    agentPost,
    announce,
    announceRoutine,
    member: memberTools,
    handleRunEvent,
    syncWaitingThread,
    handleAssistantEvent,
    reconcile,
    followProjectModels,
    start,
    idle: FiberSet.awaitEmpty(routing),
  });
});

export const layer = Layer.effect(AssistantGroups, make);

/** Fills the gate a scheduled task posts through; without it a group's schedules fail loudly. */
export const installLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gate = yield* AssistantGroupGate;
    const groups = yield* AssistantGroups;
    yield* gate.install(
      (input) =>
        groups
          .post(
            {
              teamId: input.teamId as AssistantTeamId,
              text: input.text as AssistantGroupsPostInput["text"],
              clientRequestId: input.clientRequestId,
            },
            { kind: "routine", label: input.label },
          )
          .pipe(Effect.asVoid),
      (input) =>
        groups.announceRoutine({
          teamId: input.teamId as AssistantTeamId,
          label: input.label,
          text: input.text,
          clientRequestId: input.clientRequestId,
        }),
    );
  }),
);
