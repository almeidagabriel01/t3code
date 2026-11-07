// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hash.
import * as NodeCrypto from "node:crypto";

import {
  ASSISTANT_GROUP_HANDOFF_LIMIT,
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
  type AssistantGroupsHistoryInput,
  type AssistantGroupsHistoryResult,
  type AssistantGroupsPostInput,
  type AssistantGroupsPostResult,
  type AssistantGroupsTaskActionInput,
  type AssistantId,
  type AssistantsEvent,
  type AssistantTeam,
  type AssistantTeamId,
  assistantGroupLeadingAddress,
  assistantIdFromThreadId,
  CommandId,
  isAssistantGroupThreadId,
  TextGenerationError,
  type ModelSelection,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type RunId,
  runtimeModeForToolAccess,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "../serverActivation.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { AssistantGroupGate } from "./AssistantGroupGate.ts";
import {
  childResultsText,
  groupTaskPacket,
  handOverText,
  type PacketMember,
} from "./AssistantGroupPacket.ts";
import { AssistantService } from "./AssistantService.ts";
import { type AssistantRow, toAssistant } from "./AssistantDirectory.ts";
import { type AssistantTeamRow, toAssistantTeam } from "./AssistantTeams.ts";
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
const UNROUTED_NOTICE = "Nobody got this message. Mention a member with @ to send it again.";
export const MENTION_REQUIRED_MESSAGE = "Mention a member with @, or set a lead that can route.";
const HANDOFF_LIMIT_NOTICE = `Paused · hit ${ASSISTANT_GROUP_HANDOFF_LIMIT} hand-offs for this request`;
const REPLY_TASK_REFUSAL = "This task only answers a question. Use t3_group result.";
const RESULT_WAITS_FOR_REPLY =
  "You asked a teammate a question and it is not answered yet. Wait for the answer, then post your result.";

const HISTORY_PAGE_CHARS = 24_000;
const HISTORY_MESSAGE_CHARS = 16_000;
const RESULT_MAX_CHARS = 20_000;
const ROUTING_HISTORY_MESSAGES = 10;

/** Waiting for a slot or a run, or running: work the owner is still on. */
const ACTIVE: ReadonlyArray<AssistantGroupTaskStatus> = ["queued", "running", "waiting"];
/** Everything the user can still act on. */
const OPEN: ReadonlyArray<AssistantGroupTaskStatus> = [...ACTIVE, "paused", "failed"];
const SETTLED: ReadonlyArray<AssistantGroupTaskStatus> = ["completed", "cancelled", "failed"];
const ENDED_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);
const LIVE_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"] as const;
const ACTIVE_RUN_STATUSES = ["preparing", "starting", "running", "waiting"] as const;

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

/** The member's hidden thread for a group. Look the group up in the table: team ids may hold ':'. */
export const groupThreadId = (assistantId: string, teamId: string) =>
  ThreadId.make(`assistant:${assistantId}:g-${sha256(teamId).slice(0, 16)}`);

const taskMessageId = (taskId: string, revision: number) => `group-task:${taskId}:${revision}`;

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
  readonly hops: number;
  readonly followup: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ThreadRow {
  readonly team_id: string;
  readonly assistant_id: string;
  readonly thread_id: string;
  readonly seen_seq: number;
}

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
  createdAt: row.created_at,
});

const toTask = (row: TaskRow): AssistantGroupTask => ({
  id: row.task_id as AssistantGroupTaskId,
  teamId: row.team_id as AssistantTeamId,
  rootId: row.root_id as AssistantGroupTaskId,
  parentId: row.parent_id as AssistantGroupTaskId | null,
  kind: row.kind as AssistantGroupTaskKind,
  requestMessageId: row.request_message_id as AssistantGroupMessageId,
  ownerId: row.owner_id as AssistantId,
  instruction: row.instruction,
  status: row.status as AssistantGroupTaskStatus,
  reason: row.reason,
  threadId: groupThreadId(row.owner_id, row.team_id),
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

const joinNames = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

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
    /** A post from a conversation that is not in the group: an assistant's or any agent's. */
    readonly agentPost: (input: {
      readonly callerThreadId: ThreadId;
      /** The group's id or name. */
      readonly group: string;
      readonly text: string;
      readonly paths?: ReadonlyArray<string>;
      readonly clientRequestId?: string;
    }) => Effect.Effect<AssistantGroupsPostResult, AssistantError>;
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
    };
    /** A member's run on a group thread ended or changed; moves its task along. */
    readonly handleRunEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Team and assistant changes: members leaving, groups archived or deleted. */
    readonly handleAssistantEvent: (event: AssistantsEvent) => Effect.Effect<void>;
    /** Brings group state in line with the teams now stored, for changes made while down. */
    readonly reconcile: Effect.Effect<void>;
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
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const textGeneration = yield* TextGeneration;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<{
    readonly teamId: string;
    readonly event: AssistantGroupsEvent;
  }>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  const routing = yield* FiberSet.make<void, never>();

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
    const owned = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks
      WHERE team_id = ${row.team_id} AND owner_id = ${row.assistant_id} AND status = 'running'
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
    return {
      messages: page.map(toMessage),
      tasks: tasks.map(toTask),
      hasMore: rows.length > ASSISTANT_GROUP_PAGE_SIZE,
    };
  });

  const publishMessage = (row: MessageRow) =>
    PubSub.publish(events, {
      teamId: row.team_id,
      event: { type: "message", message: toMessage(row) },
    });
  const publishTask = (row: TaskRow) =>
    PubSub.publish(events, { teamId: row.team_id, event: { type: "task", task: toTask(row) } });

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
  }) {
    const id = yield* newId("gm");
    // The next number is read in the same statement that takes it.
    const rows = yield* sql<MessageRow>`
      INSERT INTO assistant_group_messages (
        message_id, team_id, seq, author, assistant_id, author_label, kind, text, reply_to,
        task_id, client_request_id, created_at
      )
      SELECT ${id}, ${input.teamId}, COALESCE(MAX(seq), 0) + 1, ${input.author},
        ${input.assistantId ?? null}, ${input.authorLabel ?? null}, ${input.kind}, ${input.text},
        ${input.replyTo ?? null}, ${input.taskId ?? null}, ${input.clientRequestId ?? null},
        ${yield* nowIso}
      FROM assistant_group_messages WHERE team_id = ${input.teamId}
      RETURNING *`;
    yield* publishMessage(rows[0]!);
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
  }) {
    const id = yield* newId("gt");
    const now = yield* nowIso;
    const rows = yield* sql<TaskRow>`
      INSERT INTO assistant_group_tasks (
        task_id, team_id, root_id, parent_id, kind, request_message_id, owner_id, instruction,
        status, reason, revision, hops, followup, created_at, updated_at
      ) VALUES (
        ${id}, ${input.teamId}, ${input.rootId ?? id}, ${input.parentId ?? null}, ${input.kind},
        ${input.requestMessageId}, ${input.ownerId}, ${input.instruction}, ${input.status},
        ${input.reason ?? null}, 1, 0, ${input.followup ?? null}, ${now}, ${now}
      ) RETURNING *`;
    yield* publishTask(rows[0]!);
    return rows[0]!;
  });

  type TaskPatch = Partial<
    Pick<
      TaskRow,
      "status" | "reason" | "revision" | "owner_id" | "result_text" | "followup" | "hops"
    >
  >;
  const patchTask = Effect.fn("AssistantGroups.patchTask")(function* (
    task: TaskRow,
    patch: TaskPatch,
  ) {
    const next = { ...task, ...patch };
    const rows = yield* sql<TaskRow>`
      UPDATE assistant_group_tasks SET status = ${next.status}, reason = ${next.reason},
        revision = ${next.revision}, owner_id = ${next.owner_id}, result_text = ${next.result_text},
        followup = ${next.followup}, hops = ${next.hops}, updated_at = ${yield* nowIso}
      WHERE task_id = ${task.task_id} RETURNING *`;
    yield* publishTask(rows[0]!);
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
    const threadId = groupThreadId(task.owner_id, task.team_id);
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

  /** Pauses a task that is in flight, ending its run first. */
  const pauseTask = Effect.fn("AssistantGroups.pauseTask")(function* (
    task: TaskRow,
    reason: string,
  ) {
    if (!ACTIVE.includes(task.status as AssistantGroupTaskStatus)) return task;
    if (task.status === "running") yield* stopRun(task);
    return yield* patchTask(task, { status: "paused", reason });
  });

  const ensureThread = Effect.fn("AssistantGroups.ensureThread")(function* (
    team: AssistantTeam,
    member: AssistantRow,
  ) {
    const threadId = groupThreadId(member.assistant_id, team.id);
    const rows = yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_threads
      WHERE team_id = ${team.id} AND assistant_id = ${member.assistant_id}`;
    if (rows[0] === undefined) {
      const current =
        member.thread_id === null ? undefined : yield* inspectThread(member.thread_id as ThreadId);
      const projectId = member.project_id as ProjectId;
      const modelSelection: ModelSelection =
        current?.modelSelection ?? (yield* assistants.defaultModel(projectId));
      yield* launches
        .launch({
          commandId: CommandId.make(`assistant-group-launch:${team.id}:${member.assistant_id}`),
          threadId,
          projectId,
          title: `${member.name} · ${team.name}`,
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
            assistantError("storage", "Could not start the member's thread for this group."),
          ),
        );
      yield* sql`
        INSERT OR IGNORE INTO assistant_group_threads (team_id, assistant_id, thread_id, seen_seq)
        VALUES (${team.id}, ${member.assistant_id}, ${threadId}, 0)`;
      return { threadId, projectId };
    }
    const thread = yield* inspectThread(threadId);
    if (thread === undefined || thread.deletedAt !== null) {
      return yield* assistantError("storage", "The member's thread for this group is gone.");
    }
    // A member that left and came back finds its thread archived.
    if (thread.archivedAt !== null) {
      yield* dispatchLifecycle(
        `assistant-group-unarchive:${team.id}:${member.assistant_id}:${yield* newId("u")}`,
        "thread.unarchive",
        threadId,
      );
    }
    return { threadId, projectId: thread.projectId as ProjectId };
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
    const exec = yield* ensureThread(team, owner).pipe(Effect.result);
    if (exec._tag === "Failure") return yield* failed("thread_unavailable");
    const seen =
      (yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_threads
      WHERE team_id = ${team.id} AND assistant_id = ${owner.assistant_id}`)[0]?.seen_seq ?? 0;
    const chat = yield* sql<MessageRow>`
      SELECT * FROM assistant_group_messages
      WHERE team_id = ${team.id} AND seq > ${seen} AND kind = 'message'
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
    const packet = groupTaskPacket({
      group: team.name,
      taskId: task.task_id,
      kind: task.kind as AssistantGroupTaskKind,
      self: member(owner),
      members: members.map(member),
      news: chat.map((row) => ({ seq: row.seq, from: labelOf(row, names), text: row.text })),
      from,
      instruction: task.instruction,
      followup: task.followup,
    });
    const messageId = taskMessageId(task.task_id, task.revision);
    const sent = yield* threads
      .sendToThread({
        projectId: exec.success.projectId,
        commandId: CommandId.make(messageId),
        messageId: MessageId.make(messageId),
        threadId: exec.success.threadId,
        text: packet,
        attachments: [],
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
      UPDATE assistant_group_threads SET seen_seq = ${topSeq}
      WHERE team_id = ${team.id} AND assistant_id = ${owner.assistant_id}`;
    yield* patchTask(task, { status: "running", reason: null });
    return true;
  });

  /** Starts queued tasks, oldest first, while the group has free slots. */
  const pump = Effect.fn("AssistantGroups.pump")(function* (teamId: string) {
    const team = yield* loadTeam(teamId).pipe(Effect.orElseSucceed(() => undefined));
    if (team === undefined || team.archivedAt !== null) return;
    const live = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks
      WHERE team_id = ${teamId} AND status IN ('queued', 'running')
      ORDER BY updated_at ASC, rowid ASC`;
    let running = live.filter((task) => task.status === "running").length;
    for (const task of live) {
      if (running >= ASSISTANT_GROUP_PARALLEL_LIMIT) break;
      if (task.status !== "queued") continue;
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
          ownerId: recipient.assistant_id,
          instruction,
          status: "queued",
        }),
      );
    }
    return tasks;
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
        const message = yield* getMessage(messageId);
        if (lead === undefined || message === undefined) return undefined;
        const recent = yield* sql<MessageRow>`
          SELECT * FROM assistant_group_messages
          WHERE team_id = ${teamId} AND seq < ${message.seq} AND kind = 'message'
          ORDER BY seq DESC LIMIT ${ROUTING_HISTORY_MESSAGES}`;
        const names = new Map(members.map((member) => [member.assistant_id, member.name]));
        return {
          team,
          members,
          lead,
          message,
          recent: recent.toReversed().map((row) => ({
            from: labelOf(row, names),
            text: row.text,
          })),
        };
      }),
    );
    if (prepared === undefined) return;
    // The model call runs outside the lock: it takes seconds and nothing else should wait on it.
    const routeCall = textGeneration.routeAssistantGroup;
    const picked = yield* (
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
            members: prepared.members.map((member) => ({
              id: member.assistant_id,
              handle: member.handle,
              name: member.name,
              role: member.role,
              instructions: member.instructions,
            })),
            recentMessages: prepared.recent,
            request: prepared.message.text,
          })
    ).pipe(Effect.result);
    yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          // A repeat of the same routing, or a group that changed meanwhile, opens nothing twice.
          if ((yield* tasksOfMessage(messageId)).length > 0) return;
          const team = yield* loadTeam(teamId).pipe(Effect.orElseSucceed(() => undefined));
          if (team === undefined) return;
          const known = new Set(prepared.members.map((member) => member.assistant_id));
          const ids =
            picked._tag === "Success"
              ? [...new Set(picked.success.assistantIds.filter((id) => known.has(id)))]
              : [];
          const sender = prepared.message;
          const author: GroupAuthor =
            sender.author === "agent"
              ? {
                  kind: "agent",
                  assistantId: sender.assistant_id as AssistantId | null,
                  label: sender.author_label ?? "an agent",
                }
              : sender.author === "routine"
                ? { kind: "routine", label: sender.author_label ?? "" }
                : { kind: "user" };
          const instruction = instructionFor(author, sender.text);
          if (ids.length === 0) {
            yield* insertTask({
              teamId,
              kind: "root",
              requestMessageId: messageId,
              ownerId: leadId,
              instruction,
              status: "paused",
              reason: "routing_failed",
            });
            return;
          }
          const recipients = ids.flatMap((id) =>
            prepared.members.filter((member) => member.assistant_id === id),
          );
          yield* openRoots(team, prepared.message, recipients, instruction);
          if (!(ids.length === 1 && ids[0] === leadId)) {
            yield* insertMessage({
              teamId,
              author: "assistant",
              assistantId: leadId,
              kind: "routing",
              text: `${prepared.lead.name} (lead) routed it to ${joinNames(recipients.map((member) => member.name))}`,
              replyTo: messageId,
            });
          }
          yield* pump(teamId);
        }),
      )
      .pipe(storage);
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
            // First match wins: an @mention, then the member being answered, then a group of one.
            let recipients: ReadonlyArray<AssistantRow> | undefined = assistantGroupLeadingAddress(
              input.text,
              members.map((row) => ({ id: row.assistant_id, handle: row.handle, name: row.name })),
            )?.flatMap(({ id }) => members.filter((row) => row.assistant_id === id));
            if (recipients === undefined && input.replyToMessageId !== undefined) {
              const target = yield* getMessage(input.replyToMessageId);
              const task =
                target?.team_id === team.id &&
                target.author === "assistant" &&
                target.task_id !== null
                  ? yield* getTask(target.task_id)
                  : undefined;
              const owner = members.find((member) => member.assistant_id === task?.owner_id);
              if (owner !== undefined) recipients = [owner];
            }
            if (recipients === undefined && members.length === 1) recipients = members;
            let lead:
              | { readonly row: AssistantRow; readonly selection: ModelSelection }
              | undefined;
            if (recipients === undefined) {
              const row = members.find((member) => member.assistant_id === team.leadId);
              if (row !== undefined) {
                const selection = yield* leadSelection(row);
                if (yield* canRoute(selection)) lead = { row, selection };
              }
              if (lead === undefined)
                return yield* assistantError("mention_required", MENTION_REQUIRED_MESSAGE);
            }
            const message = yield* insertMessage({
              teamId: team.id,
              author: author.kind === "user" ? "user" : author.kind,
              assistantId: author.kind === "agent" ? author.assistantId : null,
              authorLabel: author.kind === "user" ? null : author.label,
              kind: "message",
              text: input.text,
              replyTo: input.replyToMessageId ?? null,
              clientRequestId: input.clientRequestId ?? null,
            });
            if (lead !== undefined) return { message, lead };
            yield* openRoots(team, message, recipients ?? [], instructionFor(author, input.text));
            yield* pump(team.id);
            return { message, lead: undefined };
          }),
        )
        .pipe(storage);
      if (outcome.lead !== undefined) {
        const { row, selection } = outcome.lead;
        yield* FiberSet.run(
          routing,
          route(input.teamId, outcome.message.message_id, row.assistant_id, selection).pipe(
            storage,
            quietly("routing"),
          ),
        );
        return { message: toMessage(outcome.message), tasks: [] };
      }
      // Read after the scheduler ran, so a task that started shows as running.
      const tasks = yield* tasksOfMessage(outcome.message.message_id).pipe(storage);
      return { message: toMessage(outcome.message), tasks: tasks.map(toTask) };
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

  const finishRun = Effect.fn("AssistantGroups.finishRun")(function* (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "run.created" | "run.updated" }>,
  ) {
    const run = event.payload;
    const key = parseTaskMessageId(run.userMessageId);
    if (key === null || !ENDED_RUN.has(run.status)) return;
    const task = yield* getTask(key.taskId);
    // A newer revision, or a task already stopped, moved on: this run's ending changes nothing.
    if (task === undefined || task.revision !== key.revision || task.status !== "running") return;
    const exec = yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_threads WHERE thread_id = ${run.threadId}`;
    const runner = exec[0]?.assistant_id;
    if (run.status === "interrupted") {
      yield* patchTask(task, { status: "paused", reason: "stopped" });
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
        task.result_text?.trim() || (yield* answerOf(run.threadId, run.id)) || "(no answer)";
      yield* insertMessage({
        teamId: task.team_id,
        author: "assistant",
        assistantId: task.owner_id,
        kind: "message",
        text: answer,
        replyTo: task.request_message_id,
        taskId: task.task_id,
      });
      const done = yield* patchTask(task, {
        status: "completed",
        reason: null,
        result_text: answer,
      });
      yield* resumeParent(done);
    }
  });

  const handleRunEvent: AssistantGroups["Service"]["handleRunEvent"] = Effect.fn(
    "AssistantGroups.handleRunEvent",
  )(
    function* (event) {
      if (event.type !== "run.created" && event.type !== "run.updated") return;
      if (!isAssistantGroupThreadId(event.payload.threadId)) return;
      if (parseTaskMessageId(event.payload.userMessageId) === null) return;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* finishRun(event);
          const owner = yield* sql<ThreadRow>`
            SELECT * FROM assistant_group_threads WHERE thread_id = ${event.payload.threadId}`;
          if (owner[0] !== undefined) yield* pump(owner[0].team_id);
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
              const stopped = yield* pauseTask(task, "stopped");
              for (const child of yield* descendants(task)) yield* pauseTask(child, "stopped");
              yield* pump(team.id);
              return toTask(stopped);
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
              if (!members.some((member) => member.assistant_id === ownerId)) {
                return yield* invalid(
                  input.action === "reassign"
                    ? "That member is not in the group."
                    : "Its member is no longer in the group; reassign it.",
                );
              }
              // Resuming a task that hit the hand-off cap goes ahead: the user is the one deciding.
              const next = yield* patchTask(task, {
                status: "queued",
                reason: null,
                owner_id: ownerId,
                revision: task.revision + 1,
                result_text: null,
              });
              yield* pump(team.id);
              return toTask((yield* getTask(next.task_id)) ?? next);
            }
            case "cancel": {
              if (status !== "paused" && status !== "failed") return yield* wrong();
              const open = yield* sql<TaskRow>`
              SELECT * FROM assistant_group_tasks
              WHERE root_id = ${task.root_id} AND status IN ${sql.in(OPEN)}`;
              let cancelled = task;
              for (const row of open) {
                if (row.status === "running") yield* stopRun(row);
                const done = yield* patchTask(row, { status: "cancelled", reason: null });
                if (row.task_id === task.task_id) cancelled = done;
              }
              yield* pump(team.id);
              return toTask(cancelled);
            }
          }
        }),
      )
      .pipe(storage);
  });

  const callerOf = Effect.fn("AssistantGroups.callerOf")(function* (threadId: ThreadId) {
    const rows = yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_threads WHERE thread_id = ${threadId}`;
    if (rows[0] === undefined) {
      return yield* invalid("This tool only works inside a group task.");
    }
    return rows[0];
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

  const memberTools: AssistantGroups["Service"]["member"] = {
    history: Effect.fn("AssistantGroups.member.history")(function* (input) {
      const caller = yield* callerOf(input.callerThreadId);
      const rows = yield* sql<MessageRow>`
          SELECT * FROM assistant_group_messages
          WHERE team_id = ${caller.team_id} AND seq < ${input.beforeSeq ?? Number.MAX_SAFE_INTEGER}
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
          const root = yield* rootOf(task);
          const over = root.hops + 1 > ASSISTANT_GROUP_HANDOFF_LIMIT;
          const child = yield* insertTask({
            teamId: team.id,
            rootId: task.root_id,
            parentId: task.task_id,
            kind: "child",
            requestMessageId: task.request_message_id,
            ownerId: target.assistant_id,
            instruction: input.instruction,
            status: over ? "paused" : "queued",
            reason: over ? "handoff_limit" : null,
          });
          if (over) {
            yield* insertMessage({
              teamId: team.id,
              author: "assistant",
              assistantId: task.owner_id,
              kind: "notice",
              text: HANDOFF_LIMIT_NOTICE,
              replyTo: task.request_message_id,
            });
          } else {
            yield* patchTask(root, { hops: root.hops + 1 });
            yield* pump(team.id);
          }
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
          const root = yield* rootOf(task);
          const over = root.hops + 1 > ASSISTANT_GROUP_HANDOFF_LIMIT;
          const from = yield* nameOf(task.owner_id);
          const moved = yield* patchTask(task, {
            owner_id: target.assistant_id,
            followup: handOverText(from, input.note),
            ...(over ? { status: "paused" as const, reason: "handoff_limit" } : {}),
          });
          if (over) {
            yield* insertMessage({
              teamId: team.id,
              author: "assistant",
              assistantId: task.owner_id,
              kind: "notice",
              text: HANDOFF_LIMIT_NOTICE,
              replyTo: task.request_message_id,
            });
            yield* pump(team.id);
          } else {
            // The new owner takes over when the caller's run ends.
            yield* patchTask(root.task_id === moved.task_id ? moved : root, {
              hops: root.hops + 1,
            });
          }
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
            target.assistant_id === null
          ) {
            return yield* invalid("Reply to a message a member wrote in this group.");
          }
          if (target.assistant_id === caller.assistant_id) {
            return yield* invalid("You cannot ask yourself.");
          }
          const members = yield* activeMembers(team);
          if (!members.some((member) => member.assistant_id === target.assistant_id)) {
            return yield* invalid("That member is no longer in the group.");
          }
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
              SELECT COUNT(*) AS n FROM assistant_group_tasks reply
              WHERE reply.kind = 'reply' AND reply.root_id IN (
                SELECT task_id FROM assistant_group_tasks
                WHERE kind = 'root' AND request_message_id = ${root.request_message_id})`)[0]!.n;
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
          });
          const reply = yield* insertTask({
            teamId: team.id,
            rootId: task.root_id,
            parentId: task.task_id,
            kind: "reply",
            requestMessageId: question.message_id,
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
          return { message: toMessage(latest), tasks: tasks.map(toTask) };
        }
      }
      return yield* post(
        {
          teamId: team.team_id as AssistantTeamId,
          text: text as AssistantGroupsPostInput["text"],
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
        },
        { kind: "agent", assistantId: assistantId as AssistantId | null, label },
      );
    },
    storage,
  );

  /** Members that left lose their open work and their thread; an archived group pauses everything. */
  const reconcileTeam = Effect.fn("AssistantGroups.reconcileTeam")(function* (team: AssistantTeam) {
    const rows =
      yield* sql<ThreadRow>`SELECT * FROM assistant_group_threads WHERE team_id = ${team.id}`;
    for (const row of rows.filter(
      (candidate) => !team.memberIds.includes(candidate.assistant_id as AssistantId),
    )) {
      const open = yield* sql<TaskRow>`
        SELECT * FROM assistant_group_tasks
        WHERE team_id = ${team.id} AND owner_id = ${row.assistant_id} AND status IN ${sql.in(ACTIVE)}`;
      for (const task of open) yield* pauseTask(task, "member_removed");
      const thread = yield* inspectThread(row.thread_id as ThreadId);
      if (thread !== undefined && thread.deletedAt === null && thread.archivedAt === null) {
        yield* dispatchLifecycle(
          `assistant-group-archive:${team.id}:${row.assistant_id}:${yield* newId("a")}`,
          "thread.archive",
          row.thread_id as ThreadId,
        );
      }
    }
    if (team.archivedAt !== null) {
      const open = yield* sql<TaskRow>`
        SELECT * FROM assistant_group_tasks
        WHERE team_id = ${team.id} AND status IN ${sql.in(ACTIVE)}`;
      for (const task of open) yield* pauseTask(task, "group_archived");
    }
    // A renamed group or member renames the hidden threads, which clients show as "Ada · Group".
    const names = new Map((yield* activeMembers(team)).map((row) => [row.assistant_id, row.name]));
    for (const row of rows) {
      const name = names.get(row.assistant_id);
      if (name === undefined) continue;
      const title = `${name} · ${team.name}`;
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
          `assistant-group-delete:${row.team_id}:${row.assistant_id}`,
          "thread.delete",
          row.thread_id as ThreadId,
        );
      }
    }
  });

  /** The group is gone: its work stops, its threads, chat and schedules go. */
  const removeGroup = Effect.fn("AssistantGroups.removeGroup")(function* (teamId: string) {
    const running = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks WHERE team_id = ${teamId} AND status = 'running'`;
    for (const task of running) yield* stopRun(task);
    yield* deleteThreads(
      yield* sql<ThreadRow>`SELECT * FROM assistant_group_threads WHERE team_id = ${teamId}`,
    );
    yield* scheduledTasks
      .deleteForTeam(teamId)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("assistant groups: schedules were not deleted", { teamId, cause }),
        ),
      );
    yield* sql`DELETE FROM assistant_group_messages WHERE team_id = ${teamId}`;
    yield* sql`DELETE FROM assistant_group_tasks WHERE team_id = ${teamId}`;
    yield* sql`DELETE FROM assistant_group_threads WHERE team_id = ${teamId}`;
  });

  /** A deleted assistant: its group threads go with it; its tasks wait for a new owner. */
  const removeAssistant = Effect.fn("AssistantGroups.removeAssistant")(function* (
    assistantId: string,
  ) {
    const rows = yield* sql<ThreadRow>`
      SELECT * FROM assistant_group_threads WHERE assistant_id = ${assistantId}`;
    const open = yield* sql<TaskRow>`
      SELECT * FROM assistant_group_tasks
      WHERE owner_id = ${assistantId} AND status IN ${sql.in(ACTIVE)}`;
    for (const task of open) yield* pauseTask(task, "member_removed");
    yield* deleteThreads(rows);
    yield* sql`DELETE FROM assistant_group_threads WHERE assistant_id = ${assistantId}`;
  });

  const handleAssistantEvent: AssistantGroups["Service"]["handleAssistantEvent"] = Effect.fn(
    "AssistantGroups.handleAssistantEvent",
  )(
    function* (event) {
      switch (event.type) {
        case "teamUpserted":
          return yield* lock.withPermits(1)(reconcileTeam(event.team));
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
        const known = new Set<string>(teams.map((team) => team.id));
        const stored = yield* sql<{ readonly team_id: string }>`
          SELECT team_id FROM assistant_group_threads
          UNION SELECT team_id FROM assistant_group_tasks
          UNION SELECT team_id FROM assistant_group_messages`;
        for (const row of stored) if (!known.has(row.team_id)) yield* removeGroup(row.team_id);
        const owners = yield* sql<{ readonly assistant_id: string }>`
          SELECT DISTINCT assistant_id FROM assistant_group_threads`;
        const existing = new Set(
          (yield* assistantRows(owners.map((row) => row.assistant_id))).map(
            (row) => row.assistant_id,
          ),
        );
        for (const row of owners)
          if (!existing.has(row.assistant_id)) yield* removeAssistant(row.assistant_id);
        // A message the lead was still routing when the server stopped is routed again.
        const unrouted = yield* sql<MessageRow>`
          SELECT * FROM assistant_group_messages m
          WHERE m.kind = 'message' AND m.author <> 'assistant'
            AND NOT EXISTS (
              SELECT 1 FROM assistant_group_tasks t WHERE t.request_message_id = m.message_id)
            AND NOT EXISTS (
              SELECT 1 FROM assistant_group_messages n
              WHERE n.reply_to = m.message_id AND n.kind = 'notice')
          ORDER BY m.seq ASC`;
        for (const message of unrouted) {
          const team = teams.find((candidate) => candidate.id === message.team_id);
          if (team === undefined || team.archivedAt !== null) continue;
          const lead = (yield* activeMembers(team)).find((row) => row.assistant_id === team.leadId);
          const selection = lead === undefined ? undefined : yield* leadSelection(lead);
          if (lead !== undefined && selection !== undefined && (yield* canRoute(selection))) {
            yield* FiberSet.run(
              routing,
              route(team.id, message.message_id, lead.assistant_id, selection).pipe(
                storage,
                quietly("routing"),
              ),
            );
          } else {
            yield* insertMessage({
              teamId: team.id,
              author: "assistant",
              assistantId: null,
              kind: "notice",
              text: UNROUTED_NOTICE,
              replyTo: message.message_id,
            });
          }
        }
      }),
    )
    .pipe(quietly("reconcile"));

  const start: AssistantGroups["Service"]["start"] = Effect.gen(function* () {
    const changes = yield* assistants.subscribeChanges;
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
    agentPost,
    member: memberTools,
    handleRunEvent,
    handleAssistantEvent,
    reconcile,
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
    yield* gate.install((input) =>
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
    );
  }),
);
