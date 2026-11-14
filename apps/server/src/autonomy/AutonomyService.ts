import {
  assistantIdFromThreadId,
  AutonomyError,
  AutonomyWatch,
  AutonomyWatchFilter,
  AutonomyWatchId,
  CommandId,
  DEFAULT_AUTONOMY_SETTINGS,
  MessageId,
  type AutonomyChannel,
  type AutonomySettings,
  type AutonomyWatchDeleteInput,
  type AutonomyWatchSetEnabledInput,
  type AutonomyWatchUpsertInput,
  type KanbanBoard,
  type KanbanCard,
  type ChannelReplyAddress,
  type Decision,
  type KanbanStreamItem,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  PROVIDER_DISPLAY_NAMES,
  type ThreadId,
  isSideChatThread,
} from "@t3tools/contracts";
import { formatThreadLink, hostedThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { groupThreadId } from "../assistants/AssistantGroups.ts";
import { AssistantSpend } from "../assistants/AssistantSpend.ts";
import { type AssistantRow, toAssistant } from "../assistants/AssistantDirectory.ts";
import { decodeReplyAddress } from "../channels/ChannelBridge.ts";
import { containsSecret } from "../channels/channelRedaction.ts";
import { ChannelLanguage } from "../channels/ChannelLanguage.ts";
import * as ChannelOutbox from "../channels/ChannelOutbox.ts";
import {
  channelStrings,
  DECISION_PHRASES,
  localizeDecision,
  localizeNoticeLabel,
  type ResolvedChannelLanguage,
} from "../channels/channelStrings.ts";
import { IMESSAGE_CONNECTION_ID } from "../channels/imessage/ImessageChannelRuntime.ts";
import * as ImessageChannelSettings from "../channels/imessage/ImessageChannelSettings.ts";
import { normalizeHandle } from "../channels/imessage/imessageHandles.ts";
import { TELEGRAM_CONNECTION_ID } from "../channels/telegram/TelegramChannelRuntime.ts";
import * as TelegramChannelSettings from "../channels/telegram/TelegramChannelSettings.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as KanbanService from "../kanban/KanbanService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  candidatesFor,
  resolveChannels,
  sourceLabel,
  wakeMessage,
  WAKE_MESSAGE_PREFIX,
  type AutonomyCandidate,
  type AutonomySignal,
} from "./autonomyRules.ts";
import { MACHINE_REQUEST_KINDS, needsYouText, requestDecision } from "./needsYou.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Rule wakes about one thread reach one assistant at most this often. */
const MIN_WAKE_INTERVAL_MS = 5 * MINUTE_MS;
const SWEEP_INTERVAL = "1 minute";
/** The waiting notice is checked more often than the wake rules, so its grace stays short. */
const NEEDS_YOU_INTERVAL = "15 seconds";
const SCHEDULED_MESSAGE_PREFIX = "scheduled-task-message:";
const USER_MESSAGE_MAX_LENGTH = 2_000;
const WORKING = new Set(["starting", "running"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

interface WatchRow {
  readonly watch_id: string;
  readonly assistant_id: string;
  readonly title: string;
  readonly filter_json: string;
  readonly instruction: string;
  readonly one_shot: number;
  readonly expires_at: string | null;
  readonly enabled: number;
  readonly trigger_count: number;
  readonly last_triggered_at: string | null;
  readonly created_at: string;
}

const FilterJson = Schema.fromJsonString(AutonomyWatchFilter);
const decodeFilter = Schema.decodeSync(FilterJson);
const encodeFilter = Schema.encodeSync(FilterJson);

const toWatch = (row: WatchRow): AutonomyWatch => ({
  id: AutonomyWatchId.make(row.watch_id),
  assistantId: row.assistant_id,
  title: row.title,
  filter: decodeFilter(row.filter_json),
  instruction: row.instruction,
  oneShot: row.one_shot === 1,
  expiresAt: row.expires_at,
  enabled: row.enabled === 1,
  triggerCount: row.trigger_count,
  lastTriggeredAt: row.last_triggered_at,
  createdAt: row.created_at,
});

const autonomyError = (reason: AutonomyError["reason"], message: string) =>
  new AutonomyError({ reason, message });

export class AutonomyService extends Context.Service<
  AutonomyService,
  {
    readonly handleEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly handleKanban: (item: KanbanStreamItem) => Effect.Effect<void>;
    /** Evaluates the time-based rules (waiting, stuck) against the clock now. */
    readonly sweep: Effect.Effect<void>;
    /**
     * Tells the user, with no model, about each request, decision and paused group task that has
     * waited on them past the grace period. Bypasses the loop guard: telling the user wakes nobody.
     */
    readonly notifyWaiting: Effect.Effect<void>;
    /** An assistant's short message to the user through their channels, asked for by the user. */
    readonly notifyUser: (input: {
      readonly assistantId: string;
      /** Identifies the message: a repeat with the same key sends nothing more. */
      readonly key: string;
      readonly text: string;
      readonly threadId?: ThreadId | undefined;
    }) => Effect.Effect<
      {
        readonly status: "sent" | "already_sent";
        readonly channels: ReadonlyArray<string>;
        readonly remainingToday: number;
      },
      AutonomyError
    >;
    readonly listWatches: Effect.Effect<ReadonlyArray<AutonomyWatch>, AutonomyError>;
    readonly upsertWatch: (
      input: AutonomyWatchUpsertInput,
    ) => Effect.Effect<AutonomyWatch, AutonomyError>;
    readonly setWatchEnabled: (
      input: AutonomyWatchSetEnabledInput,
    ) => Effect.Effect<AutonomyWatch, AutonomyError>;
    readonly deleteWatch: (
      input: AutonomyWatchDeleteInput,
    ) => Effect.Effect<{ readonly id: AutonomyWatchId }, AutonomyError>;
    /** Follows events and sweeps on a timer until the scope closes. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/autonomy/AutonomyService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const spend = yield* AssistantSpend;
  const decisions = yield* DecisionService.DecisionService;
  const outbox = yield* ChannelOutbox.ChannelOutbox;
  const channelLanguage = yield* ChannelLanguage;
  const telegram = yield* TelegramChannelSettings.TelegramChannelSettings;
  const kanban = yield* KanbanService.KanbanService;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const imessage = yield* ImessageChannelSettings.ImessageChannelSettings;
  const environment = yield* ServerEnvironment;
  const lock = yield* Semaphore.make(1);

  // What the time-based rules need; rebuilt from events after a restart, so a run that was already
  // stuck at shutdown is judged again from its next event.
  const working = yield* Ref.make(new Map<string, { threadId: string; lastActivityMs: number }>());
  const pendingRequests = yield* Ref.make(
    new Map<string, { threadId: string; openedAtMs: number }>(),
  );
  const checksState = new Map<string, string>();
  const columnOf = new Map<string, string>();
  const boards = new Map<
    string,
    { projectId: string; columns: ReadonlyMap<string, { name: string; role: string }> }
  >();
  // Cards sitting in Review with unchecked items; the rule fires on entering this state only.
  const incompleteInReview = new Set<string>();

  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

  // What already waited when waiting notices first ran (on install or the update that added them)
  // is never told: the user has seen it, and a burst of old cards would bury what is new.
  const BASELINE_SUBJECT = "baseline";
  yield* sql`
    INSERT OR IGNORE INTO autonomy_needs_you (subject_key, decision_id, created_at)
    VALUES (${BASELINE_SUBJECT}, '', ${iso(yield* Clock.currentTimeMillis)})`.pipe(
    Effect.catchCause((cause) => Effect.logWarning("autonomy: no waiting baseline", { cause })),
  );
  const waitingBaseline = sql<{ readonly created_at: string }>`
    SELECT created_at FROM autonomy_needs_you WHERE subject_key = ${BASELINE_SUBJECT}`.pipe(
    Effect.map((rows) => (rows[0] === undefined ? 0 : Date.parse(rows[0].created_at))),
  );
  const settings = settingsService.getSettings.pipe(
    Effect.map((current) => current.autonomy),
    Effect.orElseSucceed((): AutonomySettings => DEFAULT_AUTONOMY_SETTINGS),
  );

  const storage = <A, R>(self: Effect.Effect<A, SqlError | AutonomyError, R>) =>
    self.pipe(
      Effect.catchTags({
        SqlError: () =>
          Effect.fail(autonomyError("storage", "Could not read or write autonomy watches.")),
      }),
    );

  const watchRows = sql<WatchRow>`SELECT * FROM autonomy_watches ORDER BY created_at ASC`;
  const findWatch = Effect.fn("AutonomyService.findWatch")(function* (id: string) {
    const rows = yield* sql<WatchRow>`SELECT * FROM autonomy_watches WHERE watch_id = ${id}`;
    return rows[0] ?? (yield* autonomyError("not_found", "Watch not found."));
  });

  const assertAssistant = Effect.fn("AutonomyService.assertAssistant")(function* (id: string) {
    const rows = yield* sql`SELECT 1 FROM assistants WHERE assistant_id = ${id}`;
    if (rows.length === 0) return yield* autonomyError("invalid", "That assistant does not exist.");
  });

  const listWatches: AutonomyService["Service"]["listWatches"] = watchRows.pipe(
    Effect.map((rows) => rows.map(toWatch)),
    storage,
    Effect.withSpan("AutonomyService.listWatches"),
  );

  const upsertWatch: AutonomyService["Service"]["upsertWatch"] = Effect.fn(
    "AutonomyService.upsertWatch",
  )(function* (input) {
    yield* assertAssistant(input.assistantId);
    if (input.title.trim() === "")
      return yield* autonomyError("invalid", "Give the watch a title.");
    const now = iso(yield* Clock.currentTimeMillis);
    if (input.id === undefined) {
      const id = yield* random.uuidV4().pipe(Effect.orDie);
      yield* sql`
        INSERT INTO autonomy_watches (
          watch_id, assistant_id, title, filter_json, instruction, one_shot, expires_at, enabled,
          created_at
        ) VALUES (
          ${id}, ${input.assistantId}, ${input.title}, ${encodeFilter(input.filter)},
          ${input.instruction}, ${input.oneShot ? 1 : 0}, ${input.expiresAt},
          ${input.enabled === false ? 0 : 1}, ${now}
        )`;
      return toWatch(yield* findWatch(id));
    }
    const existing = yield* findWatch(input.id);
    yield* sql`
      UPDATE autonomy_watches SET assistant_id = ${input.assistantId}, title = ${input.title},
        filter_json = ${encodeFilter(input.filter)}, instruction = ${input.instruction},
        one_shot = ${input.oneShot ? 1 : 0}, expires_at = ${input.expiresAt},
        enabled = ${input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0}
      WHERE watch_id = ${input.id}`;
    return toWatch(yield* findWatch(input.id));
  }, storage);

  const setWatchEnabled: AutonomyService["Service"]["setWatchEnabled"] = Effect.fn(
    "AutonomyService.setWatchEnabled",
  )(function* (input) {
    yield* findWatch(input.id);
    yield* sql`UPDATE autonomy_watches SET enabled = ${input.enabled ? 1 : 0} WHERE watch_id = ${input.id}`;
    return toWatch(yield* findWatch(input.id));
  }, storage);

  const deleteWatch: AutonomyService["Service"]["deleteWatch"] = Effect.fn(
    "AutonomyService.deleteWatch",
  )(function* (input) {
    yield* findWatch(input.id);
    yield* sql`DELETE FROM autonomy_watches WHERE watch_id = ${input.id}`;
    return { id: input.id };
  }, storage);

  const lastAssistantMessage = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["messages"], { messageRoles: ["assistant"] }).pipe(
      Effect.map(
        (records) =>
          records.messages.findLast((message) => message.text.trim() !== "")?.text ?? null,
      ),
      Effect.orElseSucceed(() => null),
    );

  /** Sends one assistant its wake message; false when a guard or a failed send kept it back. */
  const wakeOne = Effect.fn("AutonomyService.wakeOne")(function* (
    signal: AutonomySignal,
    candidate: AutonomyCandidate,
    shell: { readonly title: string; readonly projectId: ProjectId } | null,
    config: AutonomySettings,
    nowMs: number,
  ) {
    const rows = yield* sql<AssistantRow>`
      SELECT * FROM assistants WHERE assistant_id = ${candidate.assistantId}
        AND archived_at IS NULL AND thread_id IS NOT NULL`;
    if (rows[0] === undefined) return;
    const assistant = toAssistant(rows[0]);
    const isWatch = "watch" in candidate.source;
    const wakeKey = `${signal.key}:${isWatch ? `watch:${candidate.source.watch.id}` : candidate.source.rule}:${assistant.id}`;
    if ((yield* sql`SELECT 1 FROM autonomy_wakes WHERE wake_key = ${wakeKey}`).length > 0) return;
    const watchedThreadId = signal.threadId ?? signal.subject ?? "";
    if (!isWatch) {
      const recent = yield* sql`
        SELECT 1 FROM autonomy_wakes WHERE assistant_id = ${assistant.id} AND source = 'rule'
          AND watched_thread_id = ${watchedThreadId} AND created_at > ${iso(nowMs - MIN_WAKE_INTERVAL_MS)}`;
      if (recent.length > 0) return;
    }
    const today = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM autonomy_wakes
      WHERE assistant_id = ${assistant.id} AND source <> 'notify'
        AND created_at > ${iso(nowMs - DAY_MS)}`;
    if ((today[0]?.n ?? 0) >= config.maxWakesPerDay) return;
    if (Option.isSome(yield* spend.budgetRefusal(assistant.threadId as ThreadId))) return;

    const label = sourceLabel(candidate.source);
    yield* sql`
      INSERT INTO autonomy_wakes (wake_key, assistant_id, watched_thread_id, source, label, created_at)
      VALUES (${wakeKey}, ${assistant.id}, ${watchedThreadId}, ${isWatch ? "watch" : "rule"}, ${label}, ${iso(nowMs)})`;
    const project =
      shell === null
        ? Option.none()
        : yield* projects.getById(shell.projectId).pipe(Effect.orElseSucceed(Option.none));
    const text = wakeMessage(signal, candidate.source, {
      threadTitle: shell?.title ?? null,
      threadLink:
        signal.threadId === null || shell === null
          ? null
          : formatThreadLink(
              { environmentId: null, threadId: signal.threadId as ThreadId },
              shell.title,
            ),
      projectName: Option.match(project, { onNone: () => null, onSome: (value) => value.title }),
      lastAssistantMessage:
        signal.threadId === null ? null : yield* lastAssistantMessage(signal.threadId as ThreadId),
      diffStat: null,
    });
    const id = `${WAKE_MESSAGE_PREFIX}${wakeKey}`;
    const sent = yield* threads
      .sendToThread({
        projectId: assistant.projectId,
        commandId: CommandId.make(id),
        messageId: MessageId.make(id),
        threadId: assistant.threadId as ThreadId,
        text,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (sent._tag === "Failure") {
      // Give the claim back so the next occurrence may try again.
      yield* sql`DELETE FROM autonomy_wakes WHERE wake_key = ${wakeKey}`;
      return yield* Effect.logWarning("autonomy wake could not be sent", {
        assistantId: assistant.id,
        cause: sent.failure,
      });
    }
    if (isWatch) {
      const watch = candidate.source.watch;
      yield* sql`
        UPDATE autonomy_watches SET trigger_count = trigger_count + 1,
          last_triggered_at = ${iso(nowMs)}, enabled = ${watch.oneShot ? 0 : watch.enabled ? 1 : 0}
        WHERE watch_id = ${watch.id}`;
    }
  });

  /** Turns one signal into wakes. Reads the pause switch every time, so a pause is immediate. */
  const fire = (signal: AutonomySignal) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const config = yield* settings;
          if (!config.enabled) return;
          const shell =
            signal.threadId === null
              ? null
              : yield* engine
                  .getThreadShell(signal.threadId as ThreadId)
                  .pipe(Effect.orElseSucceed(() => null));
          if (signal.threadId !== null && shell === null) return;
          // Assistants, subagents and delegated children never trigger rules: that is the loop guard.
          // Only a one-shot watch the user asked for on that very thread passes, and never its own.
          const guarded =
            signal.threadId !== null &&
            shell !== null &&
            (assistantIdFromThreadId(signal.threadId) !== null ||
              shell.lineage.relationshipToParent === "subagent" ||
              shell.delegatedFrom !== undefined ||
              isSideChatThread(shell));
          const scoped = { ...signal, projectId: signal.projectId ?? shell?.projectId ?? null };
          const assistants = (yield* sql<AssistantRow>`
            SELECT * FROM assistants WHERE archived_at IS NULL AND thread_id IS NOT NULL`).map(
            toAssistant,
          );
          const nowMs = yield* Clock.currentTimeMillis;
          const candidates = candidatesFor({
            signal: scoped,
            assistants,
            watches: (yield* watchRows).map(toWatch),
            settings: config,
            nowMs,
            watchesOnly: guarded,
          }).filter(
            (candidate) =>
              !guarded ||
              ("watch" in candidate.source &&
                candidate.source.watch.oneShot &&
                candidate.source.watch.filter.threadId === signal.threadId &&
                assistantIdFromThreadId(signal.threadId!) !== candidate.assistantId),
          );
          for (const candidate of candidates) {
            yield* wakeOne(scoped, candidate, shell, config, nowMs);
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("autonomy signal failed", { event: signal.event, cause }),
        ),
      );

  const answerOf = Effect.fn("AutonomyService.answerOf")(function* (run: {
    readonly id: string;
    readonly threadId: ThreadId;
    readonly status: string;
  }) {
    const records = yield* threads.getThreadRecords(run.threadId, ["messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [run.id as never],
      turnItemRunIds: [run.id as never],
      turnItemTypes: ["error"],
    });
    const answer = records.messages.findLast((message) => message.text.trim() !== "")?.text;
    const failure = records.turnItems.findLast((item) => item.type === "error");
    // The assistant's own answer is never translated; only the failure sentence T3 writes is.
    return (language: ResolvedChannelLanguage) =>
      answer ??
      (run.status === "failed"
        ? channelStrings(language).couldNotFinish(
            failure?.type === "error" ? failure.failure.message : undefined,
          )
        : undefined);
  });

  /**
   * The user's own chat: the first allowed Telegram user when Telegram is a channel and set up,
   * otherwise their chat with themselves in iMessage when that is on and they have written from it.
   */
  const ownerChat = Effect.fn("AutonomyService.ownerChat")(function* (
    channels: ReadonlyArray<AutonomyChannel>,
  ) {
    if (channels.includes("telegram")) {
      const snapshot = yield* telegram.get.pipe(Effect.orElseSucceed(() => null));
      const chatId = snapshot?.allowedUserIds[0];
      if (snapshot?.enabled && snapshot.tokenConfigured && chatId !== undefined) {
        return {
          kind: "telegram",
          connectionId: TELEGRAM_CONNECTION_ID,
          chatId,
        } satisfies ChannelReplyAddress as ChannelReplyAddress;
      }
    }
    const messages = yield* imessage.get.pipe(Effect.orElseSucceed(() => null));
    if (messages?.enabled !== true || messages.selfHandles.length === 0) return undefined;
    const rows = yield* sql<{ readonly address: string; readonly actor: string }>`
      SELECT json_extract(payload_json, '$.replyAddress') AS address,
        json_extract(payload_json, '$.actor.externalActorId') AS actor
      FROM channel_inbox WHERE connection_id = ${IMESSAGE_CONNECTION_ID}
      ORDER BY rowid DESC LIMIT 50`;
    const own = rows.find((row) =>
      messages.selfHandles.includes(normalizeHandle(String(row.actor)) ?? ""),
    );
    return own === undefined ? undefined : decodeReplyAddress(own.address);
  });

  /** A chat app is switched on but has no chat to the user yet: no allowed user, no message from them. */
  const chatNotReady = Effect.fn("AutonomyService.chatNotReady")(function* (
    channels: ReadonlyArray<AutonomyChannel>,
  ) {
    if (channels.includes("telegram")) {
      const snapshot = yield* telegram.get.pipe(Effect.orElseSucceed(() => null));
      if (snapshot?.enabled === true && snapshot.tokenConfigured) return true;
    }
    const messages = yield* imessage.get.pipe(Effect.orElseSucceed(() => null));
    return messages?.enabled === true;
  });

  const linkTo = (threadId: ThreadId) =>
    environment.getEnvironmentId.pipe(
      Effect.map((environmentId) => hostedThreadLink({ environmentId, threadId })),
    );

  const projectName = (projectId: string | null) =>
    projectId === null
      ? Effect.succeed(null)
      : projects.getById(projectId as ProjectId).pipe(
          Effect.map(Option.match({ onNone: () => null, onSome: (project) => project.title })),
          Effect.orElseSucceed(() => null),
        );

  type FinishedRun = {
    readonly id: string;
    readonly threadId: ThreadId;
    readonly status: string;
    readonly userMessageId: string;
  };

  const deliverResult = Effect.fn("AutonomyService.deliverResult")(function* (
    run: FinishedRun,
    label: string,
    config: AutonomySettings,
  ) {
    const assistantRows = yield* sql<AssistantRow>`
      SELECT * FROM assistants WHERE thread_id = ${run.threadId}`;
    if (assistantRows[0] === undefined) return;
    const assistant = toAssistant(assistantRows[0]);
    const render = yield* answerOf(run);
    const text = render("en");
    if (text === undefined) return;
    const channels = resolveChannels(assistant.autonomy, config);
    const chat = yield* ownerChat(channels);
    if (chat !== undefined) {
      // When the user last wrote from that chat app, the reply reactor already posts this run there.
      const chatted = yield* sql<{ readonly address_json: string }>`
        SELECT address_json FROM channel_reply_targets WHERE assistant_id = ${assistant.id}`;
      const alreadyThere = chatted.some(
        (row) => decodeReplyAddress(row.address_json).kind === chat.kind,
      );
      if (!alreadyThere) {
        const language = yield* channelLanguage.current;
        yield* outbox.enqueue({
          deliveryId: `autonomy-run:${run.id}`,
          destination: chat,
          senderName: assistant.name,
          text: `${localizeNoticeLabel(label, language)}\n\n${render(language) ?? text}`,
          markdown: true,
          language,
        });
      }
    }
    if (channels.includes("t3")) {
      const shell = yield* engine
        .getThreadShell(run.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      yield* decisions.request({
        fromThreadId: run.threadId,
        projectId: assistant.projectId,
        threadTitle: shell?.title ?? assistant.name,
        clientRequestId: `${DecisionService.NOTICE_REQUEST_PREFIX}${run.id}`,
        title: `${assistant.name}: ${label}`.slice(0, 120),
        context: text.slice(0, 4_000),
        options: [{ id: "ok", label: "Got it" }],
      });
    }
  });

  /** An autonomy wake ended: the answer goes to the configured channels, with or without a chat. */
  const deliver = Effect.fn("AutonomyService.deliver")(function* (run: FinishedRun) {
    const wakeKey = run.userMessageId.slice(WAKE_MESSAGE_PREFIX.length);
    const config = yield* settings;
    if (!config.enabled) return;
    const wakes = yield* sql<{ readonly label: string }>`
      SELECT label FROM autonomy_wakes WHERE wake_key = ${wakeKey}`;
    if (wakes[0] === undefined) return;
    yield* deliverResult(run, wakes[0].label, config);
  });

  /** A schedule in an assistant's own conversation ended: its answer reaches the user like a wake's. */
  const deliverRoutine = Effect.fn("AutonomyService.deliverRoutine")(function* (run: FinishedRun) {
    if (run.status !== "completed" && run.status !== "failed") return;
    const config = yield* settings;
    if (!config.enabled) return;
    const fireKey = run.userMessageId.slice(SCHEDULED_MESSAGE_PREFIX.length);
    // A group's routine announces in the group chat instead.
    const tasks = yield* sql<{ readonly title: string }>`
      SELECT title FROM scheduled_tasks
      WHERE assistant_team_id IS NULL AND substr(${fireKey}, 1, length(task_id) + 1) = task_id || ':'
      ORDER BY length(task_id) DESC LIMIT 1`;
    if (tasks[0] === undefined) return;
    yield* deliverResult(run, `${DECISION_PHRASES.routine} ${tasks[0].title}`, config);
  });

  const handleEvent: AutonomyService["Service"]["handleEvent"] = Effect.fn(
    "AutonomyService.handleEvent",
  )(
    function* (event) {
      const nowMs = yield* Clock.currentTimeMillis;
      if (event.runId !== undefined) {
        const runId = event.runId;
        yield* Ref.update(working, (current) =>
          current.has(runId)
            ? new Map(current).set(runId, { ...current.get(runId)!, lastActivityMs: nowMs })
            : current,
        );
      }
      switch (event.type) {
        case "run.created":
        case "run.updated": {
          const run = event.payload;
          // Waiting on an approval or an answer is not work, so it never counts as stuck.
          yield* Ref.update(working, (current) => {
            const next = new Map(current);
            if (WORKING.has(run.status)) {
              next.set(run.id, { threadId: run.threadId, lastActivityMs: nowMs });
            } else next.delete(run.id);
            return next;
          });
          if (!TERMINAL.has(run.status)) return;
          // A request left open by a run that ended will never resolve; it is not a person waiting.
          yield* Ref.update(pendingRequests, (current) => {
            const next = new Map(current);
            for (const [id, request] of current) {
              if (request.threadId === run.threadId) next.delete(id);
            }
            return next;
          });
          if (run.userMessageId.startsWith(WAKE_MESSAGE_PREFIX)) {
            yield* deliver(run);
            return;
          }
          if (
            run.userMessageId.startsWith(SCHEDULED_MESSAGE_PREFIX) &&
            assistantIdFromThreadId(run.threadId) !== null
          ) {
            yield* deliverRoutine(run);
          }
          if (run.status === "cancelled") return;
          const failed = run.status === "failed" || run.status === "interrupted";
          yield* fire({
            event: failed ? "run_failed" : "run_finished",
            key: `run:${run.id}`,
            threadId: run.threadId,
            projectId: null,
            prNumber: null,
            summary: `A run ${run.status === "completed" ? "finished" : run.status}.`,
          });
          return;
        }
        case "runtime-request.updated": {
          const request = event.payload;
          yield* Ref.update(pendingRequests, (current) => {
            const next = new Map(current);
            if (request.status === "pending") {
              if (!next.has(request.id))
                next.set(request.id, { threadId: event.threadId, openedAtMs: nowMs });
            } else next.delete(request.id);
            return next;
          });
          return;
        }
        case "thread.pull-request-link-updated":
        case "thread.pull-request-synced": {
          const links =
            event.type === "thread.pull-request-link-updated"
              ? [event.payload]
              : (event.payload.pullRequests ?? []);
          for (const link of links) {
            const state = link.snapshot?.checksState;
            if (state !== "failing" && state !== "passing") continue;
            const stateKey = `${event.threadId}:${link.number}`;
            if (checksState.get(stateKey) === state) continue;
            checksState.set(stateKey, state);
            yield* fire({
              event: state === "failing" ? "pr_checks_failed" : "pr_checks_passed",
              key: `ci:${event.threadId}:${link.number}:${state}:${link.snapshot?.updatedAt ?? link.snapshot?.syncedAt}`,
              threadId: event.threadId,
              projectId: null,
              prNumber: link.number,
              summary: `Checks ${state === "failing" ? "failed" : "passed"} on PR #${link.number} (${link.url}).`,
            });
          }
          return;
        }
        default:
          return;
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("autonomy event failed", { eventType: event.type, cause }),
        ),
      ),
  );

  const columnsOf = (board: KanbanBoard) =>
    new Map(board.columns.map((column) => [column.id, { name: column.name, role: column.role }]));
  const reviewIncomplete = (card: KanbanCard) =>
    card.archivedAt === null &&
    boards.get(card.boardId)?.columns.get(card.columnId)?.role === "review" &&
    card.checklist.some((entry) => !entry.done);

  const handleKanban: AutonomyService["Service"]["handleKanban"] = Effect.fn(
    "AutonomyService.handleKanban",
  )(function* (item) {
    if (item.kind === "snapshot") {
      for (const board of item.boards) {
        boards.set(board.id, { projectId: board.projectId, columns: columnsOf(board) });
        for (const card of board.cards) {
          columnOf.set(card.id, card.columnId);
          if (reviewIncomplete(card)) incompleteInReview.add(card.id);
        }
      }
      return;
    }
    if (item.kind === "board.upserted") {
      boards.set(item.board.id, {
        projectId: item.board.projectId,
        columns: columnsOf(item.board),
      });
      return;
    }
    if (item.kind !== "card.upserted") return;
    const { card } = item;
    const from = columnOf.get(card.id);
    columnOf.set(card.id, card.columnId);
    const board = boards.get(card.boardId);
    if (board === undefined) return;
    const columnName = board.columns.get(card.columnId)?.name ?? "another column";
    if (!reviewIncomplete(card)) {
      incompleteInReview.delete(card.id);
    } else if (!incompleteInReview.has(card.id)) {
      incompleteInReview.add(card.id);
      const open = card.checklist.filter((entry) => !entry.done).map((entry) => entry.text);
      yield* fire({
        event: "review_incomplete",
        key: `review:${card.id}:${card.updatedAt}`,
        threadId: null,
        subject: `card:${card.id}`,
        projectId: board.projectId,
        prNumber: null,
        summary: `Card #${card.number} "${card.title}" is in ${columnName} with ${open.length} unchecked item(s): ${open.slice(0, 5).join("; ")}.`,
      });
    }
    if (from === undefined || from === card.columnId) return;
    yield* fire({
      event: "card_moved",
      key: `card:${card.id}:${card.columnId}:${card.updatedAt}`,
      threadId: null,
      projectId: board.projectId,
      prNumber: null,
      summary: `Card #${card.number} "${card.title}" moved to ${columnName}.`,
    });
  });

  const sweep: AutonomyService["Service"]["sweep"] = Effect.gen(function* () {
    const config = yield* settings;
    if (!config.enabled) return;
    const nowMs = yield* Clock.currentTimeMillis;
    for (const [runId, run] of yield* Ref.get(working)) {
      if (nowMs - run.lastActivityMs < config.stuckMinutes * MINUTE_MS) continue;
      yield* fire({
        event: "stuck",
        key: `stuck:${runId}`,
        threadId: run.threadId,
        projectId: null,
        prNumber: null,
        summary: `A run has shown no activity for ${config.stuckMinutes} minutes.`,
      });
    }
    for (const [requestId, request] of yield* Ref.get(pendingRequests)) {
      if (nowMs - request.openedAtMs < config.waitingMinutes * MINUTE_MS) continue;
      yield* fire({
        event: "waiting",
        key: `waiting:${requestId}`,
        threadId: request.threadId,
        projectId: null,
        prNumber: null,
        summary: `An agent has waited ${config.waitingMinutes} minutes for the user's approval or answer.`,
      });
    }
    const open = yield* decisions.list({}).pipe(Effect.orElseSucceed(() => []));
    for (const decision of open) {
      if (
        decision.status !== "open" ||
        Date.parse(decision.createdAt) + config.waitingMinutes * MINUTE_MS > nowMs
      ) {
        continue;
      }
      yield* fire({
        event: "waiting",
        key: `waiting:decision:${decision.id}`,
        threadId: decision.fromThreadId,
        projectId: null,
        prNumber: null,
        summary: `A decision has waited ${config.waitingMinutes} minutes for an answer: "${decision.title}".`,
      });
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("autonomy sweep failed", { cause })));

  /** Who is waiting: the assistant (a group member's threads are its own), or the thread's provider. */
  const agentName = Effect.fn("AutonomyService.agentName")(function* (
    threadId: string,
    providerInstanceId: string | undefined,
  ) {
    const assistantId = assistantIdFromThreadId(threadId);
    const rows =
      assistantId === null
        ? []
        : yield* sql<{ readonly name: string }>`
            SELECT name FROM assistants WHERE assistant_id = ${assistantId}`;
    // ponytail: renamed provider instances fall back to "T3 Code"; resolve the driver if that matters.
    return (
      rows[0]?.name ??
      (providerInstanceId === undefined
        ? undefined
        : PROVIDER_DISPLAY_NAMES[providerInstanceId as keyof typeof PROVIDER_DISPLAY_NAMES]) ??
      "T3 Code"
    );
  });

  const alreadyTold = (subject: string) =>
    sql`SELECT 1 FROM autonomy_needs_you WHERE subject_key = ${subject}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const markTold = (subject: string, decisionId: string, nowMs: number) =>
    sql`
      INSERT OR IGNORE INTO autonomy_needs_you (subject_key, decision_id, created_at)
      VALUES (${subject}, ${decisionId}, ${iso(nowMs)})`;

  /**
   * The card in the user's chat; Activity already shows the decision itself. False while a chat app
   * is on but cannot reach the user yet, so the next sweep tries again instead of marking it told.
   */
  const sendNeedsYou = Effect.fn("AutonomyService.sendNeedsYou")(function* (input: {
    readonly decision: Decision;
    readonly agent: string;
    readonly threadId: ThreadId;
    readonly projectId: string | null;
    readonly threadTitle: string | null;
    readonly answerable: boolean;
    readonly config: AutonomySettings;
    readonly context?: (language: ResolvedChannelLanguage) => string;
  }) {
    const chat = yield* ownerChat(input.config.channels);
    if (chat === undefined) return !(yield* chatNotReady(input.config.channels));
    if (
      input.answerable &&
      (yield* sql`SELECT 1 FROM channel_cards WHERE decision_id = ${input.decision.id}`).length > 0
    ) {
      return true;
    }
    const language = yield* channelLanguage.current;
    const shown = localizeDecision(input.decision, language);
    const deliveryId = `needs-you:${input.decision.id}`;
    const card = needsYouText(
      {
        agent: input.agent,
        title: shown.title,
        context: input.context?.(language) ?? shown.context,
        projectName: yield* projectName(input.projectId),
        threadTitle: input.threadTitle,
        link: yield* linkTo(input.threadId),
        answerable: input.answerable,
      },
      language,
    );
    yield* outbox.enqueue({
      deliveryId,
      destination: chat,
      senderName: "T3 Code",
      text: card.text,
      ...(card.answerable
        ? { choices: shown.options.map((option) => ({ label: option.label, value: option.id })) }
        : {}),
      language,
    });
    if (card.answerable) {
      yield* sql`
        INSERT OR IGNORE INTO channel_cards (decision_id, delivery_id)
        VALUES (${input.decision.id}, ${deliveryId})`;
    }
    return true;
  });

  const notifyRequest = Effect.fn("AutonomyService.notifyRequest")(function* (
    threadId: ThreadId,
    requestId: string,
    config: AutonomySettings,
    nowMs: number,
  ) {
    const subject = `request:${requestId}`;
    if (yield* alreadyTold(subject)) return;
    const { request, item } = yield* projections.getRuntimeResponseContext(
      threadId,
      requestId as never,
    );
    if (request === undefined || request.status !== "pending") return;
    const shell = yield* engine.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.archivedAt !== null) return;
    const agent = yield* agentName(threadId, shell.providerInstanceId);
    const built = requestDecision(agent, request, item);
    const decision = yield* decisions.request({
      fromThreadId: threadId,
      projectId: shell.projectId,
      threadTitle: shell.title,
      // The same ids the assistant approval mirror uses, so an assistant's request is one decision.
      clientRequestId: !built.answerable
        ? `${DecisionService.NOTICE_REQUEST_PREFIX}needs-you:${requestId}`
        : request.kind === "user_input"
          ? `question:${requestId}`
          : `approval:${requestId}`,
      title: built.title,
      context: built.context,
      options: built.options,
      ...(built.answerable ? { approvalRequestId: requestId } : {}),
    });
    if (decision.status !== "open") return yield* markTold(subject, decision.id, nowMs);
    if (
      yield* sendNeedsYou({
        decision,
        agent,
        threadId,
        projectId: shell.projectId,
        threadTitle: shell.title,
        answerable: built.answerable,
        config,
      })
    )
      yield* markTold(subject, decision.id, nowMs);
  });

  const notifyDecision = Effect.fn("AutonomyService.notifyDecision")(function* (
    decision: Decision,
    config: AutonomySettings,
    nowMs: number,
  ) {
    const subject = `decision:${decision.id}`;
    if (yield* alreadyTold(subject)) return;
    const shell = yield* engine
      .getThreadShell(decision.fromThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (
      yield* sendNeedsYou({
        decision,
        agent: yield* agentName(decision.fromThreadId, shell?.providerInstanceId),
        threadId: decision.fromThreadId,
        projectId: shell?.projectId ?? null,
        threadTitle: decision.threadTitle,
        answerable: true,
        config,
      })
    )
      yield* markTold(subject, decision.id, nowMs);
  });

  interface PausedTask {
    readonly task_id: string;
    readonly team_id: string;
    readonly owner_id: string;
    readonly instruction: string;
    readonly reason: string | null;
    readonly thread_id: string | null;
    readonly updated_at: string;
    readonly team_name: string;
    readonly owner_name: string;
    readonly project_id: string;
  }

  const notifyGroupTask = Effect.fn("AutonomyService.notifyGroupTask")(function* (
    task: PausedTask,
    config: AutonomySettings,
    nowMs: number,
  ) {
    const subject = `group-task:${task.task_id}@${task.updated_at}`;
    if (yield* alreadyTold(subject)) return;
    const instruction = task.instruction.trim().slice(0, 1_000);
    const threadId = (task.thread_id ?? groupThreadId(task.owner_id, task.team_id)) as ThreadId;
    const contextIn = (language: ResolvedChannelLanguage) =>
      [instruction, channelStrings(language).groupTaskReason(task.reason)]
        .filter((part) => part !== "")
        .join("\n\n");
    const decision = yield* decisions.request({
      fromThreadId: threadId,
      projectId: task.project_id as ProjectId,
      threadTitle: task.team_name,
      clientRequestId: `${DecisionService.NOTICE_REQUEST_PREFIX}${subject}`,
      title: `${task.team_name}: ${DECISION_PHRASES.taskPaused}`.slice(0, 120),
      context: contextIn("en"),
      options: [{ id: "ok", label: DECISION_PHRASES.gotIt }],
    });
    if (
      yield* sendNeedsYou({
        decision,
        agent: task.owner_name,
        threadId,
        projectId: task.project_id,
        threadTitle: task.team_name,
        answerable: false,
        config,
        context: contextIn,
      })
    )
      yield* markTold(subject, decision.id, nowMs);
  });

  /** A notice whose cause settled leaves Activity; answerable mirrors are withdrawn by their reactor. */
  const withdrawSettledNotices = Effect.gen(function* () {
    const told = yield* sql<{
      readonly subject_key: string;
      readonly decision_id: string;
      readonly from_thread_id: string;
    }>`
      SELECT n.subject_key, n.decision_id, d.from_thread_id FROM autonomy_needs_you n
      JOIN decisions d ON d.decision_id = n.decision_id
      WHERE d.status = 'open'
        AND d.client_request_id LIKE ${`${DecisionService.NOTICE_REQUEST_PREFIX}%`}`;
    for (const row of told) {
      const still = row.subject_key.startsWith("request:")
        ? yield* sql`
            SELECT 1 FROM orchestration_v2_projection_runtime_requests
            WHERE runtime_request_id = ${row.subject_key.slice("request:".length)}
              AND status = 'pending'`
        : row.subject_key.startsWith("group-task:")
          ? yield* sql`
              SELECT 1 FROM assistant_group_tasks
              WHERE 'group-task:' || task_id || '@' || updated_at = ${row.subject_key}
                AND status = 'paused'`
          : [true];
      if (still.length > 0) continue;
      yield* decisions
        .withdraw({
          decisionId: row.decision_id as never,
          fromThreadId: row.from_thread_id as ThreadId,
        })
        .pipe(Effect.ignore);
    }
  });

  const isolate =
    (what: string) =>
    <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(Effect.catchCause((cause) => Effect.logWarning(what, { cause })));

  const notifyWaiting: AutonomyService["Service"]["notifyWaiting"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const config = yield* settings;
        if (!config.enabled || !config.notifyWaiting) return;
        const nowMs = yield* Clock.currentTimeMillis;
        const baseline = yield* waitingBaseline;
        const due = (createdAt: string) => {
          const at = Date.parse(createdAt);
          return at >= baseline && at + config.notifyWaitingAfterMinutes * MINUTE_MS <= nowMs;
        };

        const requests = yield* sql<{
          readonly runtime_request_id: string;
          readonly thread_id: string;
          readonly created_at: string;
        }>`
          SELECT runtime_request_id, thread_id, created_at
          FROM orchestration_v2_projection_runtime_requests
          WHERE status = 'pending' AND kind NOT IN ${sql.in(MACHINE_REQUEST_KINDS)}`;
        // One bad item never keeps the others from being told.
        for (const row of requests) {
          if (!due(row.created_at)) continue;
          yield* notifyRequest(
            row.thread_id as ThreadId,
            row.runtime_request_id,
            config,
            nowMs,
          ).pipe(isolate("autonomy: a waiting request could not be told"));
        }

        const open = yield* decisions.list({}).pipe(Effect.orElseSucceed(() => []));
        for (const decision of open) {
          // Notices only inform, and a request's mirror is told about through its request.
          if (
            decision.status !== "open" ||
            decision.notice === true ||
            decision.approvalRequestId !== undefined ||
            !due(decision.createdAt)
          ) {
            continue;
          }
          yield* notifyDecision(decision, config, nowMs).pipe(
            isolate("autonomy: an open decision could not be told"),
          );
        }

        // Stopping a task or archiving its group is the user's own doing; the rest wait on them.
        // A pause stops a whole branch, so only its top task is told: resuming it resumes the rest.
        const tasks = yield* sql<PausedTask>`
          SELECT t.task_id, t.team_id, t.owner_id, t.instruction, t.reason, t.updated_at,
            gt.thread_id, tm.name AS team_name, a.name AS owner_name, a.project_id
          FROM assistant_group_tasks t
          JOIN assistant_teams tm ON tm.team_id = t.team_id
          JOIN assistants a ON a.assistant_id = t.owner_id
          LEFT JOIN assistant_group_threads gt
            ON gt.team_id = t.team_id AND gt.assistant_id = t.owner_id
          WHERE t.status = 'paused' AND t.kind <> 'reply'
            AND COALESCE(t.reason, '') NOT IN ('stopped', 'group_archived')
            AND NOT EXISTS (
              SELECT 1 FROM assistant_group_tasks parent
              WHERE parent.task_id = t.parent_id AND parent.status = 'paused')`;
        for (const task of tasks) {
          if (!due(task.updated_at)) continue;
          yield* notifyGroupTask(task, config, nowMs).pipe(
            isolate("autonomy: a paused group task could not be told"),
          );
        }

        yield* withdrawSettledNotices;
      }),
    )
    .pipe(isolate("autonomy: the waiting notice failed"));

  const notifyUser: AutonomyService["Service"]["notifyUser"] = Effect.fn(
    "AutonomyService.notifyUser",
  )(function* (input) {
    const config = yield* settings;
    if (!config.enabled) {
      return yield* autonomyError(
        "invalid",
        "Assistant notifications are paused in Settings → Assistants → Autonomy. Tell the user in your reply instead; do not retry.",
      );
    }
    const text = input.text.trim();
    if (text === "") return yield* autonomyError("invalid", "Write the message in `text`.");
    if (text.length > USER_MESSAGE_MAX_LENGTH) {
      return yield* autonomyError(
        "invalid",
        `Keep the message under ${USER_MESSAGE_MAX_LENGTH} characters.`,
      );
    }
    if (containsSecret(text)) {
      return yield* autonomyError(
        "invalid",
        "The message looks like it holds a secret (a token, key or password). Leave it out and say where the user can find it.",
      );
    }
    const rows = yield* sql<AssistantRow>`
      SELECT * FROM assistants WHERE assistant_id = ${input.assistantId}
        AND archived_at IS NULL AND thread_id IS NOT NULL`;
    if (rows[0] === undefined) {
      return yield* autonomyError("invalid", "Only an active assistant can message the user.");
    }
    const assistant = toAssistant(rows[0]);
    const wakeKey = `notify:${input.key}`;
    const nowMs = yield* Clock.currentTimeMillis;
    const sentToday = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM autonomy_wakes
      WHERE assistant_id = ${assistant.id} AND source = 'notify'
        AND created_at > ${iso(nowMs - DAY_MS)}`;
    const count = sentToday[0]?.n ?? 0;
    if ((yield* sql`SELECT 1 FROM autonomy_wakes WHERE wake_key = ${wakeKey}`).length > 0) {
      return {
        status: "already_sent" as const,
        channels: [],
        remainingToday: Math.max(0, config.maxUserMessagesPerDay - count),
      };
    }
    if (count >= config.maxUserMessagesPerDay) {
      return yield* autonomyError(
        "invalid",
        `You already sent the user ${config.maxUserMessagesPerDay} messages today, the most allowed. Tell them in your reply instead; do not retry.`,
      );
    }
    const shell =
      input.threadId === undefined
        ? null
        : yield* engine.getThreadShell(input.threadId).pipe(Effect.orElseSucceed(() => null));
    if (input.threadId !== undefined && shell === null) {
      return yield* autonomyError("invalid", "That thread does not exist.");
    }
    yield* sql`
      INSERT INTO autonomy_wakes (wake_key, assistant_id, watched_thread_id, source, label, created_at)
      VALUES (${wakeKey}, ${assistant.id}, ${input.threadId ?? assistant.threadId}, 'notify',
        'message', ${iso(nowMs)})`;
    const link = input.threadId === undefined ? null : yield* linkTo(input.threadId);
    const withLink = (language: ResolvedChannelLanguage) =>
      link === null ? text : `${text}\n\n${channelStrings(language).openInT3} ${link}`;
    yield* decisions
      .request({
        fromThreadId: assistant.threadId as ThreadId,
        projectId: assistant.projectId,
        threadTitle: shell?.title ?? assistant.name,
        clientRequestId: `${DecisionService.NOTICE_REQUEST_PREFIX}${wakeKey}`,
        title: assistant.name.slice(0, 120),
        context: withLink("en").slice(0, 4_000),
        options: [{ id: "ok", label: DECISION_PHRASES.gotIt }],
      })
      .pipe(
        Effect.catchTags({
          DecisionError: (error) =>
            sql`DELETE FROM autonomy_wakes WHERE wake_key = ${wakeKey}`.pipe(
              Effect.andThen(Effect.fail(autonomyError("storage", error.message))),
            ),
        }),
      );
    const chat = yield* ownerChat(resolveChannels(assistant.autonomy, config));
    if (chat !== undefined) {
      const language = yield* channelLanguage.current;
      yield* outbox.enqueue({
        deliveryId: `autonomy-notify:${input.key}`,
        destination: chat,
        senderName: assistant.name,
        text: withLink(language),
        markdown: true,
        language,
      });
    }
    return {
      status: "sent" as const,
      channels: ["activity", ...(chat === undefined ? [] : [chat.kind])],
      remainingToday: config.maxUserMessagesPerDay - count - 1,
    };
  }, storage);

  const start: AutonomyService["Service"]["start"] = () =>
    Effect.all(
      [
        forkParked(
          Stream.runForEach(engine.streamDomainEvents, handleEvent).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("autonomy event stream ended", { cause }),
            ),
          ),
        ),
        forkParked(
          Stream.runForEach(kanban.subscribe(), handleKanban).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("autonomy kanban stream ended", { cause }),
            ),
          ),
        ),
        forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid)),
        forkParked(
          notifyWaiting.pipe(Effect.repeat(Schedule.spaced(NEEDS_YOU_INTERVAL)), Effect.asVoid),
        ),
      ],
      { discard: true },
    );

  return AutonomyService.of({
    handleEvent,
    handleKanban,
    sweep,
    notifyWaiting,
    notifyUser,
    listWatches,
    upsertWatch,
    setWatchEnabled,
    deleteWatch,
    start,
  });
});

export const layer = Layer.effect(AutonomyService, make);
