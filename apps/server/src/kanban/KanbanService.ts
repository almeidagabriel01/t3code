import {
  KanbanAutomations,
  KanbanChecklistItem,
  KanbanEstimate,
  KanbanError,
  KanbanLabelId,
  KanbanMutationResult,
  type CommandId,
  type KanbanActor,
  type KanbanBoard,
  type KanbanBoardEnsureInput,
  type KanbanBoardId,
  type KanbanBoardSnapshot,
  type KanbanBoardUpdateInput,
  type KanbanCard,
  type KanbanCardCommentInput,
  type KanbanCardCreateInput,
  type KanbanCardEvent,
  type KanbanCardId,
  type KanbanCardIdInput,
  type KanbanCardMoveInput,
  type KanbanCardThreadLinkInput,
  type KanbanCardUpdateInput,
  type KanbanColumn,
  type KanbanColumnCreateInput,
  type KanbanColumnDeleteInput,
  type KanbanColumnId,
  type KanbanColumnMoveInput,
  type KanbanColumnRole,
  type KanbanColumnUpdateInput,
  type KanbanGetCardInput,
  type KanbanGetCardResult,
  type KanbanLabelDeleteInput,
  type KanbanLabelUpsertInput,
  type KanbanListArchivedInput,
  type KanbanListArchivedResult,
  type KanbanStreamItem,
  type KanbanTemplate,
  type KanbanTemplateId,
  type KanbanTemplateDeleteInput,
  type KanbanTemplateUpsertInput,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { generateSpreadPinOrderKeys, pinOrderKeyBetween } from "@t3tools/shared/orderKey";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  DEFAULT_KANBAN_AUTOMATIONS,
  DEFAULT_KANBAN_COLUMNS,
  DEFAULT_KANBAN_TEMPLATES,
} from "./defaults.ts";

type KanbanResult = Effect.Effect<KanbanMutationResult, KanbanError>;

export class KanbanService extends Context.Service<
  KanbanService,
  {
    /** Snapshot of every board (live cards, no activity), then ordered deltas. */
    readonly subscribe: () => Stream.Stream<KanbanStreamItem, KanbanError>;
    readonly getCard: (
      input: KanbanGetCardInput,
    ) => Effect.Effect<KanbanGetCardResult, KanbanError>;
    readonly listArchived: (
      input: KanbanListArchivedInput,
    ) => Effect.Effect<KanbanListArchivedResult, KanbanError>;
    readonly boardEnsure: (input: KanbanBoardEnsureInput) => KanbanResult;
    readonly boardUpdate: (input: KanbanBoardUpdateInput) => KanbanResult;
    readonly columnCreate: (input: KanbanColumnCreateInput) => KanbanResult;
    readonly columnUpdate: (input: KanbanColumnUpdateInput) => KanbanResult;
    readonly columnMove: (input: KanbanColumnMoveInput) => KanbanResult;
    readonly columnDelete: (input: KanbanColumnDeleteInput) => KanbanResult;
    readonly labelUpsert: (input: KanbanLabelUpsertInput) => KanbanResult;
    readonly labelDelete: (input: KanbanLabelDeleteInput) => KanbanResult;
    readonly templateUpsert: (input: KanbanTemplateUpsertInput) => KanbanResult;
    readonly templateDelete: (input: KanbanTemplateDeleteInput) => KanbanResult;
    readonly cardCreate: (input: KanbanCardCreateInput) => KanbanResult;
    readonly cardUpdate: (input: KanbanCardUpdateInput) => KanbanResult;
    readonly cardMove: (input: KanbanCardMoveInput) => KanbanResult;
    readonly cardArchive: (input: KanbanCardIdInput) => KanbanResult;
    readonly cardUnarchive: (input: KanbanCardIdInput) => KanbanResult;
    readonly cardDelete: (input: KanbanCardIdInput) => KanbanResult;
    readonly cardComment: (input: KanbanCardCommentInput) => KanbanResult;
    readonly cardLinkThread: (input: KanbanCardThreadLinkInput) => KanbanResult;
    readonly cardUnlinkThread: (input: KanbanCardThreadLinkInput) => KanbanResult;
  }
>()("t3/kanban/KanbanService") {}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type DeltaBody = DistributiveOmit<
  Exclude<KanbanStreamItem, { readonly kind: "snapshot" }>,
  "sequence"
>;
type Outcome = {
  readonly result: Omit<KanbanMutationResult, "sequence">;
  readonly deltas: ReadonlyArray<DeltaBody>;
};

const jsonColumn = <T, E>(schema: Schema.Codec<T, E>) => {
  const codec = Schema.fromJsonString(schema);
  return { parse: Schema.decodeSync(codec), stringify: Schema.encodeSync(codec) };
};
const textList = jsonColumn(Schema.Array(Schema.String));
const labelIdList = jsonColumn(Schema.Array(KanbanLabelId));
const checklistJson = jsonColumn(Schema.Array(KanbanChecklistItem));
const estimateJson = jsonColumn(KanbanEstimate);
const automationsJson = jsonColumn(KanbanAutomations);
const payloadJson = jsonColumn(Schema.Json);
const resultJson = jsonColumn(KanbanMutationResult);

const isKanbanError = Schema.is(KanbanError);

/** Longer keys come from repeated appends; respreading the column keeps them short. */
const MAX_ORDER_KEY_LENGTH = 16;

interface BoardRow {
  readonly board_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly automations_json: string;
  readonly next_card_number: number;
  readonly created_at: string;
  readonly updated_at: string;
}
interface ColumnRow {
  readonly column_id: string;
  readonly board_id: string;
  readonly name: string;
  readonly color: string;
  readonly order_key: string;
  readonly wip_limit: number | null;
  readonly role: string;
}
interface LabelRow {
  readonly label_id: string;
  readonly board_id: string;
  readonly name: string;
  readonly color: string;
}
interface TemplateRow {
  readonly template_id: string;
  readonly board_id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly checklist_json: string;
  readonly acceptance_criteria_json: string;
  readonly label_ids_json: string;
  readonly priority: string;
}
interface CardRow {
  readonly card_id: string;
  readonly board_id: string;
  readonly column_id: string;
  readonly order_key: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly type: string | null;
  readonly priority: string;
  readonly label_ids_json: string;
  readonly due_at: string | null;
  readonly estimate_json: string | null;
  readonly checklist_json: string;
  readonly acceptance_criteria_json: string;
  readonly archived_at: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// Rows are written by this module only, so the casts restore the brands the schema put there.
const toColumn = (row: ColumnRow): KanbanColumn => ({
  id: row.column_id as KanbanColumn["id"],
  boardId: row.board_id as KanbanBoardId,
  name: row.name as KanbanColumn["name"],
  color: row.color,
  orderKey: row.order_key,
  wipLimit: row.wip_limit as KanbanColumn["wipLimit"],
  role: row.role as KanbanColumnRole,
});

const toTemplate = (row: TemplateRow): KanbanTemplate => ({
  id: row.template_id as KanbanTemplate["id"],
  name: row.name as KanbanTemplate["name"],
  icon: row.icon,
  color: row.color,
  checklist: textList.parse(row.checklist_json),
  acceptanceCriteria: textList.parse(row.acceptance_criteria_json),
  labelIds: labelIdList.parse(row.label_ids_json),
  priority: row.priority as KanbanTemplate["priority"],
});

const toCard = (
  row: CardRow,
  threadIds: ReadonlyArray<string>,
  blocks: ReadonlyArray<string>,
  blockedBy: ReadonlyArray<string>,
): KanbanCard => ({
  id: row.card_id as KanbanCardId,
  boardId: row.board_id as KanbanBoardId,
  columnId: row.column_id as KanbanColumnId,
  orderKey: row.order_key,
  number: row.number as KanbanCard["number"],
  title: row.title as KanbanCard["title"],
  description: row.description,
  type: row.type as KanbanCard["type"],
  priority: row.priority as KanbanCard["priority"],
  labelIds: labelIdList.parse(row.label_ids_json),
  dueAt: row.due_at,
  estimate: row.estimate_json === null ? null : estimateJson.parse(row.estimate_json),
  checklist: checklistJson.parse(row.checklist_json),
  acceptanceCriteria: checklistJson.parse(row.acceptance_criteria_json),
  blocks: blocks as ReadonlyArray<KanbanCardId>,
  blockedBy: blockedBy as ReadonlyArray<KanbanCardId>,
  linkedThreadIds: threadIds as ReadonlyArray<ThreadId>,
  archivedAt: row.archived_at,
  createdBy: row.created_by as KanbanActor,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const notFound = (entity: string, id: string) =>
  new KanbanError({ kind: "not_found", message: `Kanban ${entity} ${id} was not found.` });

const groupBy = <T>(items: ReadonlyArray<T>, key: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group === undefined) groups.set(key(item), [item]);
    else group.push(item);
  }
  return groups;
};

interface Placeable {
  readonly id: string;
  readonly orderKey: string;
}

/** Where `moved` lands among `others`, plus any rewritten keys when the neighbours leave no room. */
function planPlacement(
  others: ReadonlyArray<Placeable>,
  anchor: { readonly beforeId?: string | undefined; readonly afterId?: string | undefined },
  movedId: string,
): { readonly key: string; readonly rewrites: ReadonlyArray<Placeable> } | KanbanError {
  let index = others.length;
  if (anchor.beforeId !== undefined) {
    index = others.findIndex((item) => item.id === anchor.beforeId);
    if (index === -1) return notFound("placement anchor", anchor.beforeId);
  } else if (anchor.afterId !== undefined) {
    index = others.findIndex((item) => item.id === anchor.afterId) + 1;
    if (index === 0) return notFound("placement anchor", anchor.afterId);
  }
  const key = pinOrderKeyBetween(
    others[index - 1]?.orderKey ?? null,
    others[index]?.orderKey ?? null,
  );
  if (key !== null && key.length <= MAX_ORDER_KEY_LENGTH) return { key, rewrites: [] };
  const keys = generateSpreadPinOrderKeys(others.length + 1);
  const order = [...others.slice(0, index), { id: movedId, orderKey: "" }, ...others.slice(index)];
  const placed = order.map((item, position) => ({ id: item.id, orderKey: keys[position]! }));
  return {
    key: keys[index]!,
    rewrites: placed.filter((item) => item.id !== movedId),
  };
}

const toKanbanError = <A, R>(self: Effect.Effect<A, KanbanError | SqlError, R>) =>
  self.pipe(
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.fail(
          new KanbanError({ kind: "internal", message: "Kanban storage failed.", cause }),
        ),
    }),
  );

export const layer = Layer.effect(
  KanbanService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const writeLock = yield* Semaphore.make(1);
    const deltas = yield* PubSub.unbounded<KanbanStreamItem>();

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const newId = crypto.randomUUIDv4().pipe(Effect.orDie);

    const currentSequence = Effect.fn("KanbanService.currentSequence")(function* () {
      const rows = yield* sql<{
        readonly value: number;
      }>`SELECT value FROM kanban_sequence WHERE id = 1`;
      return rows[0]?.value ?? 0;
    });

    const hydrateCards = Effect.fn("KanbanService.hydrateCards")(function* (
      rows: ReadonlyArray<CardRow>,
    ) {
      if (rows.length === 0) return [] satisfies KanbanCard[];
      const ids = rows.map((row) => row.card_id);
      const links = yield* sql<{ readonly card_id: string; readonly thread_id: string }>`
        SELECT card_id, thread_id FROM kanban_card_thread_links
        WHERE card_id IN ${sql.in(ids)}
        ORDER BY linked_at ASC, thread_id ASC`;
      const edges = yield* sql<{ readonly blocker: string; readonly blocked: string }>`
        SELECT blocker_card_id AS blocker, blocked_card_id AS blocked FROM kanban_card_relations
        WHERE blocker_card_id IN ${sql.in(ids)} OR blocked_card_id IN ${sql.in(ids)}
        ORDER BY blocker_card_id ASC, blocked_card_id ASC`;
      const linksByCard = groupBy(links, (link) => link.card_id);
      const blocksByCard = groupBy(edges, (edge) => edge.blocker);
      const blockedByCard = groupBy(edges, (edge) => edge.blocked);
      return rows.map((row) =>
        toCard(
          row,
          (linksByCard.get(row.card_id) ?? []).map((link) => link.thread_id),
          (blocksByCard.get(row.card_id) ?? []).map((edge) => edge.blocked),
          (blockedByCard.get(row.card_id) ?? []).map((edge) => edge.blocker),
        ),
      );
    });

    const findCardRow = Effect.fn("KanbanService.findCardRow")(function* (cardId: string) {
      const rows = yield* sql<CardRow>`SELECT * FROM kanban_cards WHERE card_id = ${cardId}`;
      const row = rows[0];
      return row === undefined ? yield* notFound("card", cardId) : row;
    });

    const loadCard = Effect.fn("KanbanService.loadCard")(function* (cardId: string) {
      const row = yield* findCardRow(cardId);
      return (yield* hydrateCards([row]))[0]!;
    });

    const loadCards = Effect.fn("KanbanService.loadCards")(function* (cardIds: Iterable<string>) {
      const ids = [...new Set(cardIds)];
      if (ids.length === 0) return [] satisfies KanbanCard[];
      const rows = yield* sql<CardRow>`SELECT * FROM kanban_cards WHERE card_id IN ${sql.in(ids)}`;
      return yield* hydrateCards(rows);
    });

    const loadBoards = Effect.fn("KanbanService.loadBoards")(function* (boardId?: string) {
      const filter = boardId === undefined ? sql`` : sql`WHERE board_id = ${boardId}`;
      const boards = yield* sql<BoardRow>`
        SELECT * FROM kanban_boards ${filter} ORDER BY created_at ASC, board_id ASC`;
      const columns = yield* sql<ColumnRow>`
        SELECT * FROM kanban_columns ${filter} ORDER BY order_key ASC, column_id ASC`;
      const labels = yield* sql<LabelRow>`
        SELECT * FROM kanban_labels ${filter} ORDER BY rowid ASC`;
      const templates = yield* sql<TemplateRow>`
        SELECT * FROM kanban_templates ${filter} ORDER BY rowid ASC`;
      const columnsByBoard = groupBy(columns, (row) => row.board_id);
      const labelsByBoard = groupBy(labels, (row) => row.board_id);
      const templatesByBoard = groupBy(templates, (row) => row.board_id);
      return boards.map((row): KanbanBoard => ({
        id: row.board_id as KanbanBoardId,
        projectId: row.project_id as ProjectId,
        title: row.title as KanbanBoard["title"],
        columns: (columnsByBoard.get(row.board_id) ?? []).map(toColumn),
        labels: (labelsByBoard.get(row.board_id) ?? []).map((label) => ({
          id: label.label_id as KanbanBoard["labels"][number]["id"],
          name: label.name as KanbanBoard["labels"][number]["name"],
          color: label.color,
        })),
        templates: (templatesByBoard.get(row.board_id) ?? []).map(toTemplate),
        automations: automationsJson.parse(row.automations_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    });

    const loadBoard = Effect.fn("KanbanService.loadBoard")(function* (boardId: string) {
      const board = (yield* loadBoards(boardId))[0];
      return board === undefined ? yield* notFound("board", boardId) : board;
    });

    const readSnapshot = Effect.fn("KanbanService.readSnapshot")(function* () {
      const sequence = yield* currentSequence();
      const boards = yield* loadBoards();
      const rows = yield* sql<CardRow>`
        SELECT * FROM kanban_cards WHERE archived_at IS NULL
        ORDER BY column_id ASC, order_key ASC, card_id ASC`;
      const cardsByBoard = groupBy(yield* hydrateCards(rows), (card) => card.boardId);
      return {
        kind: "snapshot",
        sequence,
        boards: boards.map((board): KanbanBoardSnapshot => ({
          ...board,
          cards: cardsByBoard.get(board.id) ?? [],
        })),
      } satisfies KanbanStreamItem;
    });

    const subscribe: KanbanService["Service"]["subscribe"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading so no delta falls between snapshot and stream; the lock
          // makes the snapshot sequence equal the last published delta.
          const subscription = yield* PubSub.subscribe(deltas);
          const snapshot = yield* writeLock.withPermits(1)(readSnapshot()).pipe(toKanbanError);
          return Stream.concat(
            Stream.make<[KanbanStreamItem]>(snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((item) => item.sequence > snapshot.sequence),
            ),
          );
        }),
      );

    const getCard: KanbanService["Service"]["getCard"] = Effect.fn("KanbanService.getCard")(
      function* (input) {
        const card = yield* loadCard(input.cardId);
        const events = yield* sql<{
          readonly event_id: string;
          readonly kind: string;
          readonly actor: string;
          readonly payload_json: string;
          readonly created_at: string;
        }>`
          SELECT event_id, kind, actor, payload_json, created_at FROM kanban_card_events
          WHERE card_id = ${input.cardId} ORDER BY created_at ASC, rowid ASC`;
        return {
          card,
          activity: events.map((event): KanbanCardEvent => ({
            id: event.event_id as KanbanCardEvent["id"],
            cardId: card.id,
            kind: event.kind as KanbanCardEvent["kind"],
            actor: event.actor as KanbanActor,
            payload: payloadJson.parse(event.payload_json),
            createdAt: event.created_at,
          })),
          // Thread title/status/branch/PR and cost/time are derived in Phase 2.
          threads: card.linkedThreadIds.map((threadId) => ({
            threadId,
            title: null,
            status: null,
            branch: null,
            worktreePath: null,
            pullRequests: [],
          })),
          costUsd: null,
          totalTokens: null,
          durationMs: null,
        } satisfies KanbanGetCardResult;
      },
      toKanbanError,
    );

    const listArchived: KanbanService["Service"]["listArchived"] = Effect.fn(
      "KanbanService.listArchived",
    )(function* (input) {
      yield* loadBoard(input.boardId);
      const rows = yield* sql<CardRow>`
          SELECT * FROM kanban_cards
          WHERE board_id = ${input.boardId} AND archived_at IS NOT NULL
          ORDER BY archived_at DESC, card_id ASC`;
      return { cards: yield* hydrateCards(rows) };
    }, toKanbanError);

    /** Runs `body` once per commandId, in one transaction, then publishes its deltas in order. */
    const mutate = Effect.fn("KanbanService.mutate")(function* (
      commandId: CommandId,
      body: Effect.Effect<Outcome, KanbanError | SqlError>,
    ) {
      return yield* writeLock
        .withPermits(1)(
          Effect.gen(function* () {
            const stored = yield* sql<{ readonly result_json: string }>`
              SELECT result_json FROM kanban_commands WHERE command_id = ${commandId}`;
            if (stored[0] !== undefined) return resultJson.parse(stored[0].result_json);
            const committed = yield* sql.withTransaction(
              Effect.gen(function* () {
                const outcome = yield* body;
                let sequence = yield* currentSequence();
                const stamped = outcome.deltas.map(
                  (delta) => ({ ...delta, sequence: ++sequence }) as KanbanStreamItem,
                );
                if (stamped.length > 0) {
                  yield* sql`UPDATE kanban_sequence SET value = ${sequence} WHERE id = 1`;
                }
                const result: KanbanMutationResult = { ...outcome.result, sequence };
                yield* sql`
                  INSERT INTO kanban_commands (command_id, result_json, created_at)
                  VALUES (${commandId}, ${resultJson.stringify(result)}, ${yield* nowIso})`;
                return { result, stamped };
              }),
            );
            yield* PubSub.publishAll(deltas, committed.stamped);
            return committed.result;
          }),
        )
        .pipe(toKanbanError);
    });

    const addEvent = Effect.fn("KanbanService.addEvent")(function* (
      cardId: string,
      kind: KanbanCardEvent["kind"],
      actor: KanbanActor,
      payload: KanbanCardEvent["payload"],
    ) {
      yield* sql`
        INSERT INTO kanban_card_events (event_id, card_id, kind, actor, payload_json, created_at)
        VALUES (${yield* newId}, ${cardId}, ${kind}, ${actor}, ${payloadJson.stringify(payload)}, ${yield* nowIso})`;
    });

    const touchBoard = (boardId: string, at: string) =>
      sql`UPDATE kanban_boards SET updated_at = ${at} WHERE board_id = ${boardId}`;

    const findColumn = Effect.fn("KanbanService.findColumn")(function* (columnId: string) {
      const rows =
        yield* sql<ColumnRow>`SELECT * FROM kanban_columns WHERE column_id = ${columnId}`;
      return rows[0] === undefined ? yield* notFound("column", columnId) : rows[0];
    });

    const columnsOf = (boardId: string) =>
      sql<ColumnRow>`
        SELECT * FROM kanban_columns WHERE board_id = ${boardId} ORDER BY order_key ASC, column_id ASC`;

    const assertRoleFree = Effect.fn("KanbanService.assertRoleFree")(function* (
      boardId: string,
      role: KanbanColumnRole,
      exceptColumnId?: string,
    ) {
      if (role === "none") return;
      const taken = (yield* columnsOf(boardId)).find(
        (column) => column.role === role && column.column_id !== exceptColumnId,
      );
      if (taken !== undefined) {
        return yield* new KanbanError({
          kind: "conflict",
          message: `Column "${taken.name}" already has the ${role} role.`,
        });
      }
    });

    /** Live cards of a column in display order, minus `exceptCardId`. */
    const liveCardsOf = (columnId: string, exceptCardId?: string) =>
      sql<{ readonly id: string; readonly orderKey: string }>`
        SELECT card_id AS id, order_key AS orderKey FROM kanban_cards
        WHERE column_id = ${columnId} AND archived_at IS NULL AND card_id <> ${exceptCardId ?? ""}
        ORDER BY order_key ASC, card_id ASC`;

    const writeCardKeys = (rewrites: ReadonlyArray<Placeable>) =>
      Effect.forEach(
        rewrites,
        (item) =>
          sql`UPDATE kanban_cards SET order_key = ${item.orderKey} WHERE card_id = ${item.id}`,
        { discard: true },
      );

    const writeColumnKeys = (rewrites: ReadonlyArray<Placeable>) =>
      Effect.forEach(
        rewrites,
        (item) =>
          sql`UPDATE kanban_columns SET order_key = ${item.orderKey} WHERE column_id = ${item.id}`,
        { discard: true },
      );

    const placeOrFail = (
      others: ReadonlyArray<Placeable>,
      anchor: { readonly beforeId?: string | undefined; readonly afterId?: string | undefined },
      movedId: string,
    ) => {
      const plan = planPlacement(others, anchor, movedId);
      return isKanbanError(plan) ? Effect.fail(plan) : Effect.succeed(plan);
    };

    const cardDeltas = Effect.fn("KanbanService.cardDeltas")(function* (cardIds: Iterable<string>) {
      return (yield* loadCards(cardIds))
        .filter((card) => card.archivedAt === null)
        .map((card): DeltaBody => ({ kind: "card.upserted", card }));
    });

    const boardDelta = Effect.fn("KanbanService.boardDelta")(function* (boardId: string) {
      return { kind: "board.upserted", board: yield* loadBoard(boardId) } satisfies DeltaBody;
    });

    const boardEnsure: KanbanService["Service"]["boardEnsure"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const existing = yield* sql<{ readonly board_id: string }>`
            SELECT board_id FROM kanban_boards WHERE project_id = ${input.projectId}`;
          if (existing[0] !== undefined) {
            return {
              result: { boardId: existing[0].board_id as KanbanBoardId },
              deltas: [],
            } satisfies Outcome;
          }
          const boardId = yield* newId;
          const at = yield* nowIso;
          yield* sql`
            INSERT INTO kanban_boards (board_id, project_id, title, automations_json, created_at, updated_at)
            VALUES (${boardId}, ${input.projectId}, 'Board', ${automationsJson.stringify(DEFAULT_KANBAN_AUTOMATIONS)}, ${at}, ${at})`;
          const keys = generateSpreadPinOrderKeys(DEFAULT_KANBAN_COLUMNS.length);
          for (const [index, column] of DEFAULT_KANBAN_COLUMNS.entries()) {
            yield* sql`
              INSERT INTO kanban_columns (column_id, board_id, name, color, order_key, wip_limit, role)
              VALUES (${yield* newId}, ${boardId}, ${column.name}, ${column.color}, ${keys[index]!}, NULL, ${column.role})`;
          }
          for (const template of DEFAULT_KANBAN_TEMPLATES) {
            yield* sql`
              INSERT INTO kanban_templates (template_id, board_id, name, icon, color, checklist_json, acceptance_criteria_json, label_ids_json, priority)
              VALUES (${yield* newId}, ${boardId}, ${template.name}, ${template.icon}, ${template.color}, ${textList.stringify(template.checklist)}, ${textList.stringify(template.acceptanceCriteria)}, '[]', ${template.priority})`;
          }
          return {
            result: { boardId: boardId as KanbanBoardId },
            deltas: [yield* boardDelta(boardId)],
          } satisfies Outcome;
        }),
      );

    const actorOf = (input: { readonly actor?: KanbanActor | undefined }) =>
      input.actor ?? ("user" as KanbanActor);

    const touchCard = (cardId: string, at: string) =>
      sql`UPDATE kanban_cards SET updated_at = ${at} WHERE card_id = ${cardId}`;

    const columnUpserts = Effect.fn("KanbanService.columnUpserts")(function* (
      columnIds: Iterable<string>,
    ) {
      const ids = [...new Set(columnIds)];
      if (ids.length === 0) return [] satisfies DeltaBody[];
      const rows =
        yield* sql<ColumnRow>`SELECT * FROM kanban_columns WHERE column_id IN ${sql.in(ids)}`;
      return rows.map((row): DeltaBody => ({ kind: "column.upserted", column: toColumn(row) }));
    });

    const boardUpdate: KanbanService["Service"]["boardUpdate"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const board = yield* loadBoard(input.boardId);
          const automations: KanbanAutomations = { ...board.automations, ...input.automations };
          yield* sql`
            UPDATE kanban_boards
            SET title = ${input.title ?? board.title},
                automations_json = ${automationsJson.stringify(automations)},
                updated_at = ${yield* nowIso}
            WHERE board_id = ${input.boardId}`;
          return {
            result: { boardId: board.id },
            deltas: [yield* boardDelta(board.id)],
          } satisfies Outcome;
        }),
      );

    const columnCreate: KanbanService["Service"]["columnCreate"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const board = yield* loadBoard(input.boardId);
          const role = input.role ?? "none";
          yield* assertRoleFree(board.id, role);
          const columnId = yield* newId;
          const plan = yield* placeOrFail(
            board.columns.map((column) => ({ id: column.id, orderKey: column.orderKey })),
            { beforeId: input.beforeColumnId, afterId: input.afterColumnId },
            columnId,
          );
          yield* writeColumnKeys(plan.rewrites);
          yield* sql`
            INSERT INTO kanban_columns (column_id, board_id, name, color, order_key, wip_limit, role)
            VALUES (${columnId}, ${board.id}, ${input.name}, ${input.color ?? "slate"}, ${plan.key}, ${input.wipLimit ?? null}, ${role})`;
          return {
            result: { boardId: board.id, columnId: columnId as KanbanColumnId },
            deltas: yield* columnUpserts([...plan.rewrites.map((item) => item.id), columnId]),
          } satisfies Outcome;
        }),
      );

    const columnUpdate: KanbanService["Service"]["columnUpdate"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const column = yield* findColumn(input.columnId);
          const role = input.role ?? (column.role as KanbanColumnRole);
          if (role !== column.role) yield* assertRoleFree(column.board_id, role, column.column_id);
          yield* sql`
            UPDATE kanban_columns
            SET name = ${input.name ?? column.name},
                color = ${input.color ?? column.color},
                wip_limit = ${input.wipLimit === undefined ? column.wip_limit : input.wipLimit},
                role = ${role}
            WHERE column_id = ${column.column_id}`;
          return {
            result: { boardId: column.board_id as KanbanBoardId, columnId: input.columnId },
            deltas: yield* columnUpserts([column.column_id]),
          } satisfies Outcome;
        }),
      );

    const columnMove: KanbanService["Service"]["columnMove"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const column = yield* findColumn(input.columnId);
          const others = (yield* columnsOf(column.board_id))
            .filter((other) => other.column_id !== column.column_id)
            .map((other) => ({ id: other.column_id, orderKey: other.order_key }));
          const plan = yield* placeOrFail(
            others,
            { beforeId: input.beforeColumnId, afterId: input.afterColumnId },
            column.column_id,
          );
          yield* writeColumnKeys([...plan.rewrites, { id: column.column_id, orderKey: plan.key }]);
          return {
            result: { boardId: column.board_id as KanbanBoardId, columnId: input.columnId },
            deltas: yield* columnUpserts([
              ...plan.rewrites.map((item) => item.id),
              column.column_id,
            ]),
          } satisfies Outcome;
        }),
      );

    const columnDelete: KanbanService["Service"]["columnDelete"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const column = yield* findColumn(input.columnId);
          const target = yield* findColumn(input.targetColumnId);
          if (target.column_id === column.column_id || target.board_id !== column.board_id) {
            return yield* new KanbanError({
              kind: "invalid",
              message: "Move the cards to another column of the same board.",
            });
          }
          const moving = yield* sql<{
            readonly card_id: string;
            readonly archived_at: string | null;
          }>`
            SELECT card_id, archived_at FROM kanban_cards
            WHERE column_id = ${column.column_id} ORDER BY order_key ASC, card_id ASC`;
          const touched = new Set<string>();
          for (const card of moving) {
            if (card.archived_at !== null) {
              yield* sql`UPDATE kanban_cards SET column_id = ${target.column_id} WHERE card_id = ${card.card_id}`;
              continue;
            }
            const plan = yield* placeOrFail(yield* liveCardsOf(target.column_id), {}, card.card_id);
            yield* writeCardKeys(plan.rewrites);
            yield* sql`
              UPDATE kanban_cards SET column_id = ${target.column_id}, order_key = ${plan.key}
              WHERE card_id = ${card.card_id}`;
            touched.add(card.card_id);
            for (const item of plan.rewrites) touched.add(item.id);
          }
          yield* sql`DELETE FROM kanban_columns WHERE column_id = ${column.column_id}`;
          return {
            result: {
              boardId: column.board_id as KanbanBoardId,
              columnId: target.column_id as KanbanColumnId,
            },
            deltas: [
              ...(yield* cardDeltas(touched)),
              {
                kind: "column.removed",
                boardId: column.board_id as KanbanBoardId,
                columnId: input.columnId,
              },
            ],
          } satisfies Outcome;
        }),
      );

    const assertLabels = Effect.fn("KanbanService.assertLabels")(function* (
      boardId: string,
      labelIds: ReadonlyArray<string>,
    ) {
      if (labelIds.length === 0) return;
      const known = yield* sql<{ readonly label_id: string }>`
        SELECT label_id FROM kanban_labels WHERE board_id = ${boardId} AND label_id IN ${sql.in(labelIds)}`;
      const missing = labelIds.find((id) => !known.some((row) => row.label_id === id));
      if (missing !== undefined) return yield* notFound("label", missing);
    });

    /** Drops a label from the board's cards and templates, returning the cards that changed. */
    const stripLabel = Effect.fn("KanbanService.stripLabel")(function* (
      boardId: string,
      labelId: string,
    ) {
      const rows = yield* sql<{ readonly card_id: string; readonly label_ids_json: string }>`
        SELECT card_id, label_ids_json FROM kanban_cards WHERE board_id = ${boardId}`;
      const changed: string[] = [];
      for (const row of rows) {
        const ids = textList.parse(row.label_ids_json);
        if (!ids.includes(labelId)) continue;
        yield* sql`UPDATE kanban_cards SET label_ids_json = ${textList.stringify(ids.filter((id) => id !== labelId))} WHERE card_id = ${row.card_id}`;
        changed.push(row.card_id);
      }
      const templates = yield* sql<{
        readonly template_id: string;
        readonly label_ids_json: string;
      }>`
        SELECT template_id, label_ids_json FROM kanban_templates WHERE board_id = ${boardId}`;
      for (const row of templates) {
        const ids = textList.parse(row.label_ids_json);
        if (!ids.includes(labelId)) continue;
        yield* sql`UPDATE kanban_templates SET label_ids_json = ${textList.stringify(ids.filter((id) => id !== labelId))} WHERE template_id = ${row.template_id}`;
      }
      return changed;
    });

    const labelUpsert: KanbanService["Service"]["labelUpsert"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const board = yield* loadBoard(input.boardId);
          const labelId = input.labelId ?? ((yield* newId) as KanbanLabelId);
          if (input.labelId === undefined) {
            yield* sql`
              INSERT INTO kanban_labels (label_id, board_id, name, color)
              VALUES (${labelId}, ${board.id}, ${input.name}, ${input.color})`;
          } else {
            if (!board.labels.some((label) => label.id === labelId)) {
              return yield* notFound("label", labelId);
            }
            yield* sql`UPDATE kanban_labels SET name = ${input.name}, color = ${input.color} WHERE label_id = ${labelId}`;
          }
          yield* touchBoard(board.id, yield* nowIso);
          return {
            result: { boardId: board.id, labelId },
            deltas: [yield* boardDelta(board.id)],
          } satisfies Outcome;
        }),
      );

    const labelDelete: KanbanService["Service"]["labelDelete"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const board = yield* loadBoard(input.boardId);
          if (!board.labels.some((label) => label.id === input.labelId)) {
            return yield* notFound("label", input.labelId);
          }
          yield* sql`DELETE FROM kanban_labels WHERE label_id = ${input.labelId}`;
          const changed = yield* stripLabel(board.id, input.labelId);
          yield* touchBoard(board.id, yield* nowIso);
          return {
            result: { boardId: board.id, labelId: input.labelId },
            deltas: [yield* boardDelta(board.id), ...(yield* cardDeltas(changed))],
          } satisfies Outcome;
        }),
      );

    const templateUpsert: KanbanService["Service"]["templateUpsert"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const board = yield* loadBoard(input.boardId);
          yield* assertLabels(board.id, input.labelIds);
          const templateId = input.templateId ?? ((yield* newId) as KanbanTemplateId);
          const checklist = textList.stringify(input.checklist);
          const criteria = textList.stringify(input.acceptanceCriteria);
          const labelIds = labelIdList.stringify(input.labelIds);
          if (input.templateId === undefined) {
            yield* sql`
              INSERT INTO kanban_templates (template_id, board_id, name, icon, color, checklist_json, acceptance_criteria_json, label_ids_json, priority)
              VALUES (${templateId}, ${board.id}, ${input.name}, ${input.icon}, ${input.color}, ${checklist}, ${criteria}, ${labelIds}, ${input.priority})`;
          } else {
            if (!board.templates.some((template) => template.id === templateId)) {
              return yield* notFound("template", templateId);
            }
            yield* sql`
              UPDATE kanban_templates
              SET name = ${input.name}, icon = ${input.icon}, color = ${input.color}, checklist_json = ${checklist},
                  acceptance_criteria_json = ${criteria}, label_ids_json = ${labelIds}, priority = ${input.priority}
              WHERE template_id = ${templateId}`;
          }
          yield* touchBoard(board.id, yield* nowIso);
          return {
            result: { boardId: board.id, templateId },
            deltas: [yield* boardDelta(board.id)],
          } satisfies Outcome;
        }),
      );

    const templateDelete: KanbanService["Service"]["templateDelete"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const board = yield* loadBoard(input.boardId);
          if (!board.templates.some((template) => template.id === input.templateId)) {
            return yield* notFound("template", input.templateId);
          }
          const typed = yield* sql<{ readonly card_id: string }>`
            SELECT card_id FROM kanban_cards WHERE board_id = ${board.id} AND type = ${input.templateId}`;
          yield* sql`UPDATE kanban_cards SET type = NULL WHERE board_id = ${board.id} AND type = ${input.templateId}`;
          yield* sql`DELETE FROM kanban_templates WHERE template_id = ${input.templateId}`;
          yield* touchBoard(board.id, yield* nowIso);
          return {
            result: { boardId: board.id, templateId: input.templateId },
            deltas: [
              yield* boardDelta(board.id),
              ...(yield* cardDeltas(typed.map((row) => row.card_id))),
            ],
          } satisfies Outcome;
        }),
      );

    /** Keeps ids the caller supplied and mints the rest; ids stay unique within a list. */
    const withChecklistIds = Effect.fn("KanbanService.withChecklistIds")(function* (
      items: ReadonlyArray<{
        readonly id?: string | undefined;
        readonly text: string;
        readonly done: boolean;
      }>,
    ) {
      const resolved: KanbanChecklistItem[] = [];
      for (const item of items) {
        const id = (item.id ?? (yield* newId)) as KanbanChecklistItem["id"];
        if (resolved.some((other) => other.id === id)) {
          return yield* new KanbanError({
            kind: "invalid",
            message: `Checklist id ${id} is repeated.`,
          });
        }
        resolved.push({ id, text: item.text, done: item.done });
      }
      return resolved;
    });

    const seedChecklist = (texts: ReadonlyArray<string>) =>
      withChecklistIds(texts.map((text) => ({ text, done: false })));

    const cardCreate: KanbanService["Service"]["cardCreate"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const board = yield* loadBoard(input.boardId);
          const column =
            input.columnId === undefined
              ? (board.columns.find((candidate) => candidate.role === "backlog") ??
                board.columns[0])
              : board.columns.find((candidate) => candidate.id === input.columnId);
          if (column === undefined) {
            return yield* input.columnId === undefined
              ? new KanbanError({ kind: "invalid", message: "The board has no columns." })
              : notFound("column", input.columnId);
          }
          const template =
            input.type == null
              ? undefined
              : board.templates.find((candidate) => candidate.id === input.type);
          if (input.type != null && template === undefined) {
            return yield* notFound("template", input.type);
          }
          const labelIds = input.labelIds ?? template?.labelIds ?? [];
          yield* assertLabels(board.id, labelIds);
          const checklist = yield* input.checklist === undefined
            ? seedChecklist(template?.checklist ?? [])
            : withChecklistIds(input.checklist);
          const acceptanceCriteria = yield* input.acceptanceCriteria === undefined
            ? seedChecklist(template?.acceptanceCriteria ?? [])
            : withChecklistIds(input.acceptanceCriteria);
          const numbers = yield* sql<{ readonly next_card_number: number }>`
            SELECT next_card_number FROM kanban_boards WHERE board_id = ${board.id}`;
          const number = numbers[0]!.next_card_number;
          yield* sql`UPDATE kanban_boards SET next_card_number = ${number + 1} WHERE board_id = ${board.id}`;
          const cardId = yield* newId;
          const plan = yield* placeOrFail(yield* liveCardsOf(column.id), {}, cardId);
          yield* writeCardKeys(plan.rewrites);
          const at = yield* nowIso;
          const actor = actorOf(input);
          yield* sql`
            INSERT INTO kanban_cards (card_id, board_id, column_id, order_key, number, title, description, type, priority, label_ids_json, due_at, estimate_json, checklist_json, acceptance_criteria_json, archived_at, created_by, created_at, updated_at)
            VALUES (${cardId}, ${board.id}, ${column.id}, ${plan.key}, ${number}, ${input.title}, ${input.description ?? ""}, ${input.type ?? null}, ${input.priority ?? template?.priority ?? "none"}, ${labelIdList.stringify(labelIds)}, ${input.dueAt ?? null}, ${input.estimate == null ? null : estimateJson.stringify(input.estimate)}, ${checklistJson.stringify(checklist)}, ${checklistJson.stringify(acceptanceCriteria)}, NULL, ${actor}, ${at}, ${at})`;
          yield* addEvent(cardId, "created", actor, { title: input.title, columnId: column.id });
          return {
            result: {
              boardId: board.id,
              cardId: cardId as KanbanCardId,
              number: number as KanbanCard["number"],
            },
            deltas: yield* cardDeltas([...plan.rewrites.map((item) => item.id), cardId]),
          } satisfies Outcome;
        }),
      );

    const relationsOf = Effect.fn("KanbanService.relationsOf")(function* (cardId: string) {
      const edges = yield* sql<{ readonly blocker: string; readonly blocked: string }>`
        SELECT blocker_card_id AS blocker, blocked_card_id AS blocked FROM kanban_card_relations
        WHERE blocker_card_id = ${cardId} OR blocked_card_id = ${cardId}`;
      return {
        blocks: edges.filter((edge) => edge.blocker === cardId).map((edge) => edge.blocked),
        blockedBy: edges.filter((edge) => edge.blocked === cardId).map((edge) => edge.blocker),
      };
    });

    /** Replaces one side of a card's relations; returns the other cards whose view changed. */
    const replaceRelations = Effect.fn("KanbanService.replaceRelations")(function* (
      card: CardRow,
      side: "blocks" | "blockedBy",
      next: ReadonlyArray<string>,
    ) {
      const wanted = [...new Set(next)];
      if (wanted.includes(card.card_id)) {
        return yield* new KanbanError({ kind: "invalid", message: "A card cannot block itself." });
      }
      if (wanted.length > 0) {
        const found = yield* sql<{ readonly card_id: string }>`
          SELECT card_id FROM kanban_cards WHERE board_id = ${card.board_id} AND card_id IN ${sql.in(wanted)}`;
        const missing = wanted.find((id) => !found.some((row) => row.card_id === id));
        if (missing !== undefined) return yield* notFound("card", missing);
      }
      const current = (yield* relationsOf(card.card_id))[side];
      const added = wanted.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !wanted.includes(id));
      for (const other of added) {
        const [blocker, blocked] =
          side === "blocks" ? [card.card_id, other] : [other, card.card_id];
        yield* sql`INSERT INTO kanban_card_relations (blocker_card_id, blocked_card_id) VALUES (${blocker}, ${blocked})`;
      }
      for (const other of removed) {
        const [blocker, blocked] =
          side === "blocks" ? [card.card_id, other] : [other, card.card_id];
        yield* sql`DELETE FROM kanban_card_relations WHERE blocker_card_id = ${blocker} AND blocked_card_id = ${blocked}`;
      }
      return [...added, ...removed];
    });

    const cardUpdate: KanbanService["Service"]["cardUpdate"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const row = yield* findCardRow(input.cardId);
          const board = yield* loadBoard(row.board_id);
          if (
            input.type != null &&
            !board.templates.some((template) => template.id === input.type)
          ) {
            return yield* notFound("template", input.type);
          }
          if (input.labelIds !== undefined) yield* assertLabels(board.id, input.labelIds);
          const checklist =
            input.checklist === undefined ? undefined : yield* withChecklistIds(input.checklist);
          const criteria =
            input.acceptanceCriteria === undefined
              ? undefined
              : yield* withChecklistIds(input.acceptanceCriteria);
          const next = {
            title: input.title ?? row.title,
            description: input.description ?? row.description,
            type: input.type === undefined ? row.type : input.type,
            priority: input.priority ?? row.priority,
            label_ids_json:
              input.labelIds === undefined
                ? row.label_ids_json
                : labelIdList.stringify(input.labelIds),
            due_at: input.dueAt === undefined ? row.due_at : input.dueAt,
            estimate_json:
              input.estimate === undefined
                ? row.estimate_json
                : input.estimate === null
                  ? null
                  : estimateJson.stringify(input.estimate),
            checklist_json:
              checklist === undefined ? row.checklist_json : checklistJson.stringify(checklist),
            acceptance_criteria_json:
              criteria === undefined
                ? row.acceptance_criteria_json
                : checklistJson.stringify(criteria),
          };
          const fields: string[] = (
            [
              ["title", next.title !== row.title],
              ["description", next.description !== row.description],
              ["type", next.type !== row.type],
              ["priority", next.priority !== row.priority],
              ["labelIds", next.label_ids_json !== row.label_ids_json],
              ["dueAt", next.due_at !== row.due_at],
              ["estimate", next.estimate_json !== row.estimate_json],
              ["checklist", next.checklist_json !== row.checklist_json],
              [
                "acceptanceCriteria",
                next.acceptance_criteria_json !== row.acceptance_criteria_json,
              ],
            ] as const
          )
            .filter(([, changed]) => changed)
            .map(([name]) => name);
          const related = new Set<string>();
          if (input.blocks !== undefined) {
            for (const id of yield* replaceRelations(row, "blocks", input.blocks)) related.add(id);
          }
          if (input.blockedBy !== undefined) {
            for (const id of yield* replaceRelations(row, "blockedBy", input.blockedBy)) {
              related.add(id);
            }
          }
          if (related.size > 0) fields.push("relations");
          const result = { cardId: input.cardId, boardId: board.id };
          if (fields.length === 0) return { result, deltas: [] } satisfies Outcome;
          yield* sql`
            UPDATE kanban_cards
            SET title = ${next.title}, description = ${next.description}, type = ${next.type}, priority = ${next.priority},
                label_ids_json = ${next.label_ids_json}, due_at = ${next.due_at}, estimate_json = ${next.estimate_json},
                checklist_json = ${next.checklist_json}, acceptance_criteria_json = ${next.acceptance_criteria_json},
                updated_at = ${yield* nowIso}
            WHERE card_id = ${row.card_id}`;
          yield* addEvent(row.card_id, "field-changed", actorOf(input), { fields });
          return {
            result,
            deltas: yield* cardDeltas([row.card_id, ...related]),
          } satisfies Outcome;
        }),
      );

    const cardMove: KanbanService["Service"]["cardMove"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const row = yield* findCardRow(input.cardId);
          if (row.archived_at !== null) {
            return yield* new KanbanError({
              kind: "invalid",
              message: "Unarchive the card before moving it.",
            });
          }
          const target = yield* findColumn(input.columnId);
          if (target.board_id !== row.board_id) {
            return yield* new KanbanError({
              kind: "invalid",
              message: "The column belongs to another board.",
            });
          }
          const plan = yield* placeOrFail(
            yield* liveCardsOf(target.column_id, row.card_id),
            { beforeId: input.beforeCardId, afterId: input.afterCardId },
            row.card_id,
          );
          yield* writeCardKeys(plan.rewrites);
          yield* sql`
            UPDATE kanban_cards
            SET column_id = ${target.column_id}, order_key = ${plan.key}, updated_at = ${yield* nowIso}
            WHERE card_id = ${row.card_id}`;
          if (target.column_id !== row.column_id) {
            yield* addEvent(row.card_id, "moved", actorOf(input), {
              fromColumnId: row.column_id,
              toColumnId: target.column_id,
            });
          }
          return {
            result: { cardId: input.cardId, boardId: row.board_id as KanbanBoardId },
            deltas: yield* cardDeltas([row.card_id, ...plan.rewrites.map((item) => item.id)]),
          } satisfies Outcome;
        }),
      );

    const cardArchive: KanbanService["Service"]["cardArchive"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const row = yield* findCardRow(input.cardId);
          const result = { cardId: input.cardId, boardId: row.board_id as KanbanBoardId };
          if (row.archived_at !== null) return { result, deltas: [] } satisfies Outcome;
          const at = yield* nowIso;
          yield* sql`UPDATE kanban_cards SET archived_at = ${at}, updated_at = ${at} WHERE card_id = ${row.card_id}`;
          yield* addEvent(row.card_id, "archived", actorOf(input), {});
          return {
            result,
            deltas: [{ kind: "card.removed", boardId: result.boardId, cardId: input.cardId }],
          } satisfies Outcome;
        }),
      );

    const cardUnarchive: KanbanService["Service"]["cardUnarchive"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const row = yield* findCardRow(input.cardId);
          const result = { cardId: input.cardId, boardId: row.board_id as KanbanBoardId };
          if (row.archived_at === null) return { result, deltas: [] } satisfies Outcome;
          const plan = yield* placeOrFail(
            yield* liveCardsOf(row.column_id, row.card_id),
            {},
            row.card_id,
          );
          yield* writeCardKeys(plan.rewrites);
          yield* sql`
            UPDATE kanban_cards SET archived_at = NULL, order_key = ${plan.key}, updated_at = ${yield* nowIso}
            WHERE card_id = ${row.card_id}`;
          yield* addEvent(row.card_id, "unarchived", actorOf(input), {});
          return {
            result,
            deltas: yield* cardDeltas([row.card_id, ...plan.rewrites.map((item) => item.id)]),
          } satisfies Outcome;
        }),
      );

    const cardDelete: KanbanService["Service"]["cardDelete"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const row = yield* findCardRow(input.cardId);
          const relations = yield* relationsOf(row.card_id);
          // Cascades remove the card's events, thread links, and relation edges.
          yield* sql`DELETE FROM kanban_cards WHERE card_id = ${row.card_id}`;
          const boardId = row.board_id as KanbanBoardId;
          return {
            result: { cardId: input.cardId, boardId },
            deltas: [
              { kind: "card.removed", boardId, cardId: input.cardId },
              ...(yield* cardDeltas([...relations.blocks, ...relations.blockedBy])),
            ],
          } satisfies Outcome;
        }),
      );

    const cardComment: KanbanService["Service"]["cardComment"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const row = yield* findCardRow(input.cardId);
          yield* addEvent(row.card_id, "comment", actorOf(input), { body: input.body });
          return {
            result: { cardId: input.cardId, boardId: row.board_id as KanbanBoardId },
            deltas: [],
          } satisfies Outcome;
        }),
      );

    const cardLinkThread: KanbanService["Service"]["cardLinkThread"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const row = yield* findCardRow(input.cardId);
          const result = { cardId: input.cardId, boardId: row.board_id as KanbanBoardId };
          const existing = yield* sql<{ readonly card_id: string }>`
            SELECT card_id FROM kanban_card_thread_links WHERE thread_id = ${input.threadId}`;
          if (existing[0]?.card_id === row.card_id) return { result, deltas: [] } satisfies Outcome;
          if (existing[0] !== undefined) {
            return yield* new KanbanError({
              kind: "conflict",
              message: "The thread is already linked to another card.",
            });
          }
          const at = yield* nowIso;
          yield* sql`INSERT INTO kanban_card_thread_links (thread_id, card_id, linked_at) VALUES (${input.threadId}, ${row.card_id}, ${at})`;
          yield* touchCard(row.card_id, at);
          yield* addEvent(row.card_id, "linked", actorOf(input), { threadId: input.threadId });
          return { result, deltas: yield* cardDeltas([row.card_id]) } satisfies Outcome;
        }),
      );

    const cardUnlinkThread: KanbanService["Service"]["cardUnlinkThread"] = (input) =>
      mutate(
        input.commandId,
        Effect.gen(function* () {
          const row = yield* findCardRow(input.cardId);
          const result = { cardId: input.cardId, boardId: row.board_id as KanbanBoardId };
          const existing = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM kanban_card_thread_links
            WHERE thread_id = ${input.threadId} AND card_id = ${row.card_id}`;
          if (existing[0] === undefined) return { result, deltas: [] } satisfies Outcome;
          yield* sql`DELETE FROM kanban_card_thread_links WHERE thread_id = ${input.threadId}`;
          yield* touchCard(row.card_id, yield* nowIso);
          yield* addEvent(row.card_id, "unlinked", actorOf(input), { threadId: input.threadId });
          return { result, deltas: yield* cardDeltas([row.card_id]) } satisfies Outcome;
        }),
      );

    return KanbanService.of({
      subscribe,
      getCard,
      listArchived,
      boardEnsure,
      boardUpdate,
      columnCreate,
      columnUpdate,
      columnMove,
      columnDelete,
      labelUpsert,
      labelDelete,
      templateUpsert,
      templateDelete,
      cardCreate,
      cardUpdate,
      cardMove,
      cardArchive,
      cardUnarchive,
      cardDelete,
      cardComment,
      cardLinkThread,
      cardUnlinkThread,
    });
  }),
);
