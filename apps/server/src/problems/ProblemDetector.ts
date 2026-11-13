/**
 * Turns failures into one kanban card per cause and wakes one assistant to handle it, without a
 * model. `report` only stores the occurrence; `tick` files, counts and wakes from what is stored,
 * one occurrence at a time, so a replay, a burst or a crash between steps changes nothing twice.
 */
import {
  CommandId,
  DEFAULT_AUTONOMY_SETTINGS,
  KanbanError,
  MessageId,
  type KanbanActor,
  type KanbanCardId,
  type KanbanCardProblem,
  type KanbanCardSetProblemIgnoredInput,
  type KanbanMutationResult,
  type OrchestrationV2DomainEvent,
  type ProblemKind,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { type AssistantRow, toAssistant } from "../assistants/AssistantDirectory.ts";
import { AssistantSpend } from "../assistants/AssistantSpend.ts";
import { WAKE_MESSAGE_PREFIX } from "../autonomy/autonomyRules.ts";
import * as AutonomyService from "../autonomy/AutonomyService.ts";
import type { HeavyEventRecord } from "../heavyQueue/heavyNotices.ts";
import * as HeavyQueueNotices from "../heavyQueue/HeavyQueueNotices.ts";
import * as KanbanService from "../kanban/KanbanService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  cardTitle,
  classify,
  detectionEnabled,
  effectiveLevel,
  evidenceDescription,
  fingerprint,
  folderOwner,
  noOwnerNotice,
  noticeHeader,
  excerpt,
  selectOwner,
  summaryOf,
  wakeText,
  type ProblemEvidence,
  type ProblemReason,
  type ProblemReport,
  type WakeCase,
} from "./problemRules.ts";
import {
  checksReport,
  isOwnLoop,
  linkReport,
  runnerReport,
  runReport,
  scheduledReport,
  sessionReport,
  type LinkRow,
  type ScheduledRow,
} from "./problemSources.ts";

const TICK_INTERVAL = "15 seconds";
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_THREADS = 10;
const AUTOMATION = "automation" as KanbanActor;

interface OccurrenceRow {
  readonly event_key: string;
  readonly fingerprint: string | null;
  readonly project_id: string;
  readonly kind: string | null;
  readonly reason: string | null;
  readonly report_json: string;
  readonly occurred_at: string;
}

interface CauseRow {
  readonly fingerprint: string;
  readonly project_id: string;
  readonly generation: number;
  readonly card_id: string;
  readonly card_number: number;
  readonly previous_card_number: number | null;
  readonly kind: string;
  readonly count: number;
  readonly owner_id: string | null;
  readonly ignored: number;
  readonly evidence_json: string;
  readonly last_comment_at: string | null;
}

interface WakeRow {
  readonly card_id: string;
  readonly owner_id: string | null;
  readonly project_id: string;
  readonly reassigned: number;
}

// Rows hold this server's own encodings; a bad one throws, and tick marks that occurrence failed.
const jsonCodec = Schema.fromJsonString(Schema.Unknown);
const toJson = Schema.encodeSync(jsonCodec);
const fromJson = Schema.decodeSync(jsonCodec);

export class ProblemDetector extends Context.Service<
  ProblemDetector,
  {
    /** Stores one occurrence; the same `key` again is a no-op. Never fails. */
    readonly report: (report: ProblemReport) => Effect.Effect<void>;
    /** Files and counts stored occurrences, moves cases whose owner left, and wakes owners. */
    readonly tick: Effect.Effect<void>;
    readonly setIgnored: (
      input: KanbanCardSetProblemIgnoredInput,
    ) => Effect.Effect<KanbanMutationResult, KanbanError>;
    /** Runs, provider sessions and PR checks from the orchestration event stream. */
    readonly handleEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly handleRecord: (record: HeavyEventRecord) => Effect.Effect<void>;
    /** Schedules and environment links, which keep their failures as state. */
    readonly poll: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/problems/ProblemDetector") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const kanban = yield* KanbanService.KanbanService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const spend = yield* AssistantSpend;
  const autonomy = yield* AutonomyService.AutonomyService;
  const heavy = yield* HeavyQueueNotices.HeavyQueueNotices;
  const lock = yield* Semaphore.make(1);

  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const settings = settingsService.getSettings.pipe(
    Effect.orElseSucceed(() => null as ServerSettings | null),
  );

  const folderProject = Effect.fn("ProblemDetector.folderProject")(function* (folder: string) {
    const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
    const worktrees = yield* projections
      .getThreadWorktreePaths({ includeArchived: true })
      .pipe(Effect.orElseSucceed(() => []));
    const owner = folderOwner<`${"project" | "thread"}:${string}`>(folder, [
      ...shells.map((shell) => ({ id: `project:${shell.id}` as const, root: shell.workspaceRoot })),
      ...worktrees.map((tree) => ({
        id: `thread:${tree.threadId}` as const,
        root: tree.worktreePath,
      })),
    ]);
    if (owner === null) return null;
    if (owner.startsWith("project:")) return owner.slice("project:".length);
    const shell = yield* engine
      .getThreadShell(owner.slice("thread:".length) as ThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    return shell?.projectId ?? null;
  });

  const projectName = (projectId: string) =>
    projects.getById(projectId as ProjectId).pipe(
      Effect.map(Option.match({ onNone: () => projectId, onSome: (project) => project.title })),
      Effect.orElseSucceed(() => projectId),
    );

  /** Open: it exists, is not archived, and is not in a done column. */
  const cardOpen = (cardId: string) =>
    sql<{ readonly role: string; readonly archived_at: string | null }>`
      SELECT col.role, c.archived_at FROM kanban_cards c
      JOIN kanban_columns col ON col.column_id = c.column_id
      WHERE c.card_id = ${cardId}`.pipe(
      Effect.map(
        (rows) => rows[0] !== undefined && rows[0].archived_at === null && rows[0].role !== "done",
      ),
    );

  const activeAssistants = sql<AssistantRow>`
    SELECT * FROM assistants WHERE archived_at IS NULL AND thread_id IS NOT NULL`.pipe(
    Effect.map((rows) =>
      rows.map(toAssistant).map((assistant) => ({
        ...assistant,
        notifies: assistant.autonomy.mode === "reply-and-notify",
      })),
    ),
  );

  const report: ProblemDetector["Service"]["report"] = Effect.fn("ProblemDetector.report")(
    function* (input) {
      const shell =
        input.projectId !== null || input.threadId === null
          ? null
          : yield* engine
              .getThreadShell(input.threadId as ThreadId)
              .pipe(Effect.orElseSucceed(() => null));
      const projectId =
        input.projectId ??
        shell?.projectId ??
        (input.projectFolder == null ? null : yield* folderProject(input.projectFolder)) ??
        (yield* folders.ensureScratchProject.pipe(Effect.map((scratch) => scratch.projectId)));
      const resolved: ProblemReport = {
        ...input,
        projectId,
        threadTitle: input.threadTitle ?? shell?.title ?? null,
      };
      const classified = classify(resolved);
      yield* sql`
        INSERT OR IGNORE INTO problem_occurrences
          (event_key, fingerprint, project_id, kind, reason, report_json, occurred_at)
        VALUES (${input.key}, ${fingerprint(resolved, projectId, classified?.reason ?? null)},
          ${projectId}, ${classified?.kind ?? null}, ${classified?.reason ?? null},
          ${toJson(resolved)}, ${iso(input.at)})`;
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          sql`
            INSERT OR IGNORE INTO problem_occurrences
              (event_key, project_id, report_json, occurred_at, processed_at, skip_reason)
            VALUES (${input.key}, '', ${toJson(input)}, ${iso(input.at)},
              ${iso(input.at)}, 'unresolved')`.pipe(
            Effect.andThen(Effect.logWarning("problem report could not be stored", { cause })),
            Effect.ignore,
          ),
        ),
      ),
  );

  const skip = (key: string, reason: string, nowMs: number) =>
    sql`UPDATE problem_occurrences SET processed_at = ${iso(nowMs)}, skip_reason = ${reason} WHERE event_key = ${key}`;

  const threadOf = (report: ProblemReport) =>
    report.threadId === null
      ? []
      : [{ id: report.threadId, title: report.threadTitle ?? report.threadId }];

  const problemOf = (cause: {
    readonly kind: string;
    readonly count: number;
    readonly previous_card_number: number | null;
    readonly ignored: number;
    readonly ownerName: string | null;
  }): KanbanCardProblem => ({
    kind: cause.kind as ProblemKind,
    count: cause.count as KanbanCardProblem["count"],
    ownerName: cause.ownerName,
    previousCardNumber: cause.previous_card_number as KanbanCardProblem["previousCardNumber"],
    ignored: cause.ignored === 1,
  });

  const ownerName = (ownerId: string | null) =>
    ownerId === null
      ? Effect.succeed(null)
      : sql<{
          readonly name: string;
        }>`SELECT name FROM assistants WHERE assistant_id = ${ownerId}`.pipe(
          Effect.map((rows) => rows[0]?.name ?? null),
        );

  const processOne = Effect.fn("ProblemDetector.processOne")(function* (
    row: OccurrenceRow,
    config: ServerSettings,
    nowMs: number,
  ) {
    const key = row.event_key;
    if (row.fingerprint === null) return yield* skip(key, "unresolved", nowMs);
    if (!detectionEnabled(config, row.project_id)) return yield* skip(key, "detection_off", nowMs);
    const cause = (yield* sql<CauseRow>`
      SELECT * FROM problem_causes WHERE fingerprint = ${row.fingerprint}`)[0];
    if (cause?.ignored === 1) return yield* skip(key, "ignored", nowMs);
    const report = fromJson(row.report_json) as ProblemReport;
    const open = cause !== undefined && (yield* cardOpen(cause.card_id));
    let kind = row.kind as ProblemKind | null;
    let reason = row.reason as ProblemReason | null;
    if (kind === null && !open) {
      const seen = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM problem_occurrences
        WHERE fingerprint = ${row.fingerprint} AND occurred_at > ${iso(report.at - DAY_MS)}
          AND occurred_at <= ${row.occurred_at}`;
      if ((seen[0]?.n ?? 0) < 3) return yield* skip(key, "not_a_problem", nowMs);
      kind = "repeated";
      reason = "repeated";
    }

    if (open) {
      const previous = fromJson(cause.evidence_json) as ProblemEvidence;
      const evidence: ProblemEvidence = {
        ...previous,
        lastSeen: Math.max(previous.lastSeen, report.at),
        threads: [
          ...previous.threads.filter((thread) => thread.id !== report.threadId),
          ...threadOf(report),
        ].slice(-MAX_THREADS),
      };
      const count = cause.count + 1;
      const cardId = cause.card_id as KanbanCardId;
      yield* kanban.cardUpdate({
        commandId: CommandId.make(`problem:${key}:evidence`),
        actor: AUTOMATION,
        cardId,
        description: evidenceDescription(evidence),
      });
      yield* kanban.cardSetProblem({
        commandId: CommandId.make(`problem:${key}:state`),
        cardId,
        problem: problemOf({ ...cause, count, ownerName: yield* ownerName(cause.owner_id) }),
      });
      const comment =
        cause.last_comment_at === null || Date.parse(cause.last_comment_at) <= nowMs - HOUR_MS;
      if (comment) {
        yield* kanban.cardComment({
          commandId: CommandId.make(`problem:${key}:comment`),
          actor: AUTOMATION,
          cardId,
          body: `Seen ${count} times`,
        });
      }
      yield* sql.withTransaction(
        Effect.all([
          sql`
            UPDATE problem_causes SET count = ${count}, evidence_json = ${toJson(evidence)},
              last_comment_at = ${comment ? iso(nowMs) : cause.last_comment_at},
              updated_at = ${iso(nowMs)}
            WHERE fingerprint = ${cause.fingerprint}`,
          sql`UPDATE problem_occurrences SET processed_at = ${iso(nowMs)} WHERE event_key = ${key}`,
        ]),
      );
      return;
    }

    const evidence: ProblemEvidence = {
      source: report.source,
      reason: reason ?? "repeated",
      prNumber: report.prNumber,
      command: report.command,
      error: excerpt(report.error),
      where: report.where,
      firstSeen: report.at,
      lastSeen: report.at,
      threads: threadOf(report),
    };
    const board = yield* kanban.boardEnsure({
      commandId: CommandId.make(`problem:${key}:board`),
      actor: AUTOMATION,
      projectId: row.project_id as ProjectId,
    });
    const created = yield* kanban.cardCreate({
      commandId: CommandId.make(`problem:${key}:card`),
      actor: AUTOMATION,
      boardId: board.boardId!,
      title: cardTitle(kind ?? "repeated", report.error),
      description: evidenceDescription(evidence),
    });
    const owner = selectOwner(yield* activeAssistants, row.project_id);
    const fresh = {
      kind: kind ?? "repeated",
      count: 1,
      previous_card_number: cause?.card_number ?? null,
      ignored: 0,
      ownerName: owner?.name ?? null,
    };
    yield* kanban.cardSetProblem({
      commandId: CommandId.make(`problem:${key}:state`),
      cardId: created.cardId!,
      problem: problemOf(fresh),
    });
    yield* sql.withTransaction(
      Effect.all([
        sql`
          INSERT INTO problem_causes (fingerprint, project_id, generation, card_id, card_number,
            previous_card_number, kind, count, owner_id, ignored, evidence_json, updated_at)
          VALUES (${row.fingerprint}, ${row.project_id}, ${(cause?.generation ?? 0) + 1},
            ${created.cardId!}, ${created.number!}, ${fresh.previous_card_number}, ${kind}, 1,
            ${owner?.id ?? null}, 0, ${toJson(evidence)}, ${iso(nowMs)})
          ON CONFLICT (fingerprint) DO UPDATE SET generation = excluded.generation,
            card_id = excluded.card_id, card_number = excluded.card_number,
            previous_card_number = excluded.previous_card_number, kind = excluded.kind,
            count = 1, owner_id = excluded.owner_id, evidence_json = excluded.evidence_json,
            last_comment_at = NULL, updated_at = excluded.updated_at`,
        sql`INSERT OR IGNORE INTO problem_cards (card_id, fingerprint) VALUES (${created.cardId!}, ${row.fingerprint})`,
        sql`
          INSERT OR REPLACE INTO problem_wakes (card_id, owner_id, project_id, reassigned, created_at)
          VALUES (${created.cardId!}, ${owner?.id ?? null}, ${row.project_id}, 0, ${iso(nowMs)})`,
        sql`UPDATE problem_occurrences SET processed_at = ${iso(nowMs)} WHERE event_key = ${key}`,
      ]),
    );
  });

  /** An owner archived, deleted or taken off the project hands its open cases to the next one. */
  const reassign = Effect.fn("ProblemDetector.reassign")(function* (nowMs: number) {
    const causes = yield* sql<CauseRow>`SELECT * FROM problem_causes WHERE ignored = 0`;
    const assistants = yield* activeAssistants;
    for (const cause of causes) {
      const owner = selectOwner(assistants, cause.project_id);
      if ((owner?.id ?? null) === cause.owner_id || !(yield* cardOpen(cause.card_id))) continue;
      yield* kanban.cardSetProblem({
        commandId: CommandId.make(`problem-owner:${cause.card_id}:${owner?.id ?? "none"}:${nowMs}`),
        cardId: cause.card_id as KanbanCardId,
        problem: problemOf({ ...cause, ownerName: owner?.name ?? null }),
      });
      yield* sql.withTransaction(
        Effect.all([
          sql`UPDATE problem_causes SET owner_id = ${owner?.id ?? null}, updated_at = ${iso(nowMs)} WHERE fingerprint = ${cause.fingerprint}`,
          sql`
            INSERT OR REPLACE INTO problem_wakes (card_id, owner_id, project_id, reassigned, created_at)
            VALUES (${cause.card_id}, ${owner?.id ?? null}, ${cause.project_id}, 1, ${iso(nowMs)})`,
        ]),
      );
    }
  });

  const causeOfCard = (cardId: string) =>
    sql<CauseRow>`
      SELECT c.* FROM problem_cards pc JOIN problem_causes c ON c.fingerprint = pc.fingerprint
      WHERE pc.card_id = ${cardId}`.pipe(Effect.map((rows) => rows[0]));

  /** Within the owner's daily limits and budget; otherwise its wake waits for the next tick. */
  const mayWake = Effect.fn("ProblemDetector.mayWake")(function* (
    assistantId: string,
    threadId: string,
    config: ServerSettings["autonomy"],
    nowMs: number,
  ) {
    const today = yield* sql<{ readonly wakes: number; readonly messages: number }>`
      SELECT COALESCE(SUM(source <> 'notify'), 0) AS wakes, COALESCE(SUM(source = 'notify'), 0) AS messages
      FROM autonomy_wakes WHERE assistant_id = ${assistantId} AND created_at > ${iso(nowMs - DAY_MS)}`;
    if ((today[0]?.wakes ?? 0) >= config.maxWakesPerDay) return false;
    if ((today[0]?.messages ?? 0) >= config.maxUserMessagesPerDay) return false;
    return Option.isNone(yield* spend.budgetRefusal(threadId as ThreadId));
  });

  /** One wake per owner for every case waiting on it, so a burst or a cross-project cause is one message. */
  const flush = Effect.fn("ProblemDetector.flush")(function* (
    config: ServerSettings,
    nowMs: number,
  ) {
    const autonomyConfig = config.autonomy ?? DEFAULT_AUTONOMY_SETTINGS;
    if (!autonomyConfig.enabled) return;
    const pending = yield* sql<WakeRow>`SELECT * FROM problem_wakes ORDER BY created_at, card_id`;
    const byOwner = new Map<string | null, Array<{ row: WakeRow; cause: CauseRow }>>();
    for (const row of pending) {
      const cause = yield* causeOfCard(row.card_id);
      if (cause === undefined || cause.ignored === 1 || !(yield* cardOpen(row.card_id))) {
        yield* sql`DELETE FROM problem_wakes WHERE card_id = ${row.card_id}`;
        continue;
      }
      byOwner.set(row.owner_id, [...(byOwner.get(row.owner_id) ?? []), { row, cause }]);
    }
    for (const [ownerId, items] of byOwner) {
      if (ownerId === null) {
        const told = new Set<string>();
        for (const { row, cause } of items) {
          if (!told.has(row.project_id)) {
            told.add(row.project_id);
            const evidence = fromJson(cause.evidence_json) as ProblemEvidence;
            yield* autonomy.tellUser({
              key: `problem-no-owner:${row.card_id}`,
              text: noOwnerNotice(yield* projectName(row.project_id)),
              projectId: row.project_id as ProjectId,
              threadId: (evidence.threads[0]?.id ?? null) as ThreadId | null,
            });
          }
          yield* sql`DELETE FROM problem_wakes WHERE card_id = ${row.card_id}`;
        }
        continue;
      }
      const rows = yield* sql<AssistantRow>`
        SELECT * FROM assistants WHERE assistant_id = ${ownerId}
          AND archived_at IS NULL AND thread_id IS NOT NULL`;
      // A gone owner's cases move to the next owner on the next tick.
      if (rows[0] === undefined) continue;
      const owner = toAssistant(rows[0]);
      if (!(yield* mayWake(owner.id, owner.threadId!, autonomyConfig, nowMs))) continue;
      const cases: WakeCase[] = [];
      for (const { row, cause } of items) {
        const evidence = fromJson(cause.evidence_json) as ProblemEvidence;
        cases.push({
          header: noticeHeader(
            yield* projectName(row.project_id),
            summaryOf(evidence.error),
            cause.card_number,
          ),
          cardId: row.card_id,
          projectId: row.project_id,
          description: evidenceDescription(evidence),
          count: cause.count,
          reassigned: row.reassigned === 1,
        });
      }
      const wakeKey = `problem:${owner.id}:${nowMs}:${items[0]!.row.card_id}`;
      yield* sql`
        INSERT INTO autonomy_wakes (wake_key, assistant_id, watched_thread_id, source, label, created_at)
        VALUES (${wakeKey}, ${owner.id}, ${owner.threadId!}, 'problem',
          ${cases.map((item) => item.header).join("\n")}, ${iso(nowMs)})`;
      const id = `${WAKE_MESSAGE_PREFIX}${wakeKey}`;
      const sent = yield* threads
        .sendToThread({
          projectId: owner.projectId,
          commandId: CommandId.make(id),
          messageId: MessageId.make(id),
          threadId: owner.threadId!,
          text: wakeText(cases, effectiveLevel(owner.autonomy.onProblem, owner.toolAccess)),
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.result);
      if (sent._tag === "Failure") {
        yield* sql`DELETE FROM autonomy_wakes WHERE wake_key = ${wakeKey}`;
        yield* Effect.logWarning("problem wake could not be sent", {
          assistantId: owner.id,
          cause: sent.failure,
        });
        continue;
      }
      for (const { row } of items) {
        yield* sql`DELETE FROM problem_wakes WHERE card_id = ${row.card_id}`;
      }
    }
  });

  const isolate =
    (what: string) =>
    <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(Effect.catchCause((cause) => Effect.logWarning(what, { cause })));

  const tick: ProblemDetector["Service"]["tick"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const config = yield* settings;
        if (config === null) return;
        const nowMs = yield* Clock.currentTimeMillis;
        const pending = yield* sql<OccurrenceRow>`
          SELECT * FROM problem_occurrences WHERE processed_at IS NULL
          ORDER BY occurred_at, event_key`;
        // One bad occurrence never stops the others; it keeps its reason.
        for (const row of pending) {
          yield* processOne(row, config, nowMs).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("problem occurrence could not be filed", {
                key: row.event_key,
                cause,
              }).pipe(Effect.andThen(skip(row.event_key, "failed", nowMs))),
            ),
            isolate("problem occurrence skip could not be recorded"),
          );
        }
        yield* reassign(nowMs).pipe(isolate("problem owners could not be moved"));
        yield* flush(config, nowMs).pipe(isolate("problem wakes could not be sent"));
      }),
    )
    .pipe(isolate("problem tick failed"), Effect.withSpan("ProblemDetector.tick"));

  const setIgnored: ProblemDetector["Service"]["setIgnored"] = Effect.fn(
    "ProblemDetector.setIgnored",
  )(function* (input) {
    const cause = yield* causeOfCard(input.cardId).pipe(
      Effect.mapError(
        (cause) =>
          new KanbanError({ kind: "internal", message: "Could not read the problem.", cause }),
      ),
    );
    if (cause === undefined) {
      return yield* new KanbanError({
        kind: "invalid",
        message: "This card is not a problem card.",
      });
    }
    yield* sql`UPDATE problem_causes SET ignored = ${input.ignored ? 1 : 0} WHERE fingerprint = ${cause.fingerprint}`.pipe(
      Effect.mapError(
        (cause) =>
          new KanbanError({ kind: "internal", message: "Could not save the problem.", cause }),
      ),
    );
    const problem = problemOf({
      ...cause,
      ignored: input.ignored ? 1 : 0,
      ownerName: yield* ownerName(cause.owner_id).pipe(Effect.orElseSucceed(() => null)),
    });
    // An older card of the cause keeps its own count and number, and shows the same switch.
    const card = yield* kanban.getCard({ cardId: input.cardId });
    return yield* kanban.cardSetProblem({
      commandId: input.commandId,
      cardId: input.cardId,
      problem:
        card.card.id === cause.card_id || card.card.problem === null
          ? problem
          : { ...card.card.problem, ignored: input.ignored },
    });
  });

  const runError = (threadId: ThreadId, runId: string) =>
    threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemRunIds: [runId as never],
        turnItemTypes: ["error"],
      })
      .pipe(
        Effect.map((records) => {
          const item = records.turnItems.findLast((candidate) => candidate.type === "error");
          return item?.type === "error" ? item.failure.message : null;
        }),
        Effect.orElseSucceed(() => null),
      );

  // Last checks state per PR link, so only a change into failing is an occurrence.
  const checksState = new Map<string, string>();

  const handleEvent: ProblemDetector["Service"]["handleEvent"] = Effect.fn(
    "ProblemDetector.handleEvent",
  )(
    function* (event) {
      const nowMs = yield* Clock.currentTimeMillis;
      switch (event.type) {
        case "run.created":
        case "run.updated": {
          const run = event.payload;
          if (run.status !== "failed") return;
          const shell = yield* engine
            .getThreadShell(run.threadId)
            .pipe(Effect.orElseSucceed(() => null));
          if (shell === null || isOwnLoop(run.threadId, shell)) return;
          // AssistantTaskReactor already wakes the task's assistant about this run.
          const task = yield* sql`SELECT 1 FROM assistant_tasks WHERE thread_id = ${run.threadId}`;
          if (task.length > 0) return;
          const found = runReport(run, yield* runError(run.threadId, run.id), nowMs);
          if (found !== null) yield* report({ ...found, threadTitle: shell.title });
          return;
        }
        case "provider-session.attached":
        case "provider-session.updated": {
          const found = sessionReport(event.threadId, event.payload, nowMs);
          if (found !== null) yield* report(found);
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
            if (state == null) continue;
            const stateKey = `${event.threadId}:${link.number}`;
            const before = checksState.get(stateKey);
            checksState.set(stateKey, state);
            if (state !== "failing" || before === "failing") continue;
            yield* report(
              checksReport(
                event.threadId,
                {
                  number: link.number,
                  url: link.url,
                  stamp: String(link.snapshot?.updatedAt ?? link.snapshot?.syncedAt ?? ""),
                },
                nowMs,
              ),
            );
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
          Effect.logWarning("problem event failed", { eventType: event.type, cause }),
        ),
      ),
  );

  const handleRecord: ProblemDetector["Service"]["handleRecord"] = Effect.fn(
    "ProblemDetector.handleRecord",
  )(
    function* (record) {
      const found = runnerReport(record);
      if (found === null) return;
      // The queue file is shared by every server on this Mac: only this server's threads are ours.
      // ponytail: a job with no thread is filed by each of them; tag jobs with a server id if that bites.
      if (found.threadId !== null) {
        const shell = yield* engine
          .getThreadShell(found.threadId as ThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null) return;
      }
      yield* report(found);
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning("problem record failed", { cause })),
      ),
  );

  const poll: ProblemDetector["Service"]["poll"] = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const scheduled = yield* sql<ScheduledRow>`
      SELECT task_id, title, project_id, thread_id, assistant_team_id, last_run_at, last_run_error
      FROM scheduled_tasks
      WHERE last_run_status = 'failed' AND last_run_at IS NOT NULL
        AND last_run_at > ${iso(nowMs - DAY_MS)}`;
    for (const row of scheduled) {
      const found = scheduledReport(row);
      if (found !== null) yield* report(found);
    }
    const links = yield* sql<LinkRow>`
      SELECT environment_id, label, last_error, last_reached_at, linked_at
      FROM peer_environment_links WHERE last_error IS NOT NULL`;
    for (const row of links) yield* report(linkReport(row, nowMs));
  }).pipe(isolate("problem poll failed"), Effect.withSpan("ProblemDetector.poll"));

  const start: ProblemDetector["Service"]["start"] = () =>
    Effect.all(
      [
        forkParked(
          Stream.runForEach(engine.streamDomainEvents, handleEvent).pipe(
            isolate("problem event stream ended"),
          ),
        ),
        forkParked(Stream.runForEach(heavy.records, handleRecord)),
        forkParked(
          poll.pipe(
            Effect.andThen(tick),
            Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
            Effect.asVoid,
          ),
        ),
      ],
      { discard: true },
    );

  return ProblemDetector.of({ report, tick, setIgnored, handleEvent, handleRecord, poll, start });
});

export const layer = Layer.effect(ProblemDetector, make);
