import {
  KanbanColumnId,
  KanbanTemplateId,
  OrchestratorMcpFailure,
  type KanbanActor,
  type KanbanBoardSnapshot,
  type KanbanCard,
  type KanbanError,
  type ProjectId,
  type ThreadId,
  CommandId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as KanbanService from "../../../kanban/KanbanService.ts";
import * as Project from "../../../project/ProjectService.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, newCommandId, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { applyChecklistOps } from "./checklistOps.ts";
import { type KanbanParameters, KanbanToolkit } from "./tools.ts";

type Json = Schema.Json;
type Out = Record<string, Json>;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const kanbanFailure = (error: KanbanError) =>
  error.kind === "internal" ? unavailable() : invalid(error.message);

const need = <T>(value: T | undefined, name: string, action: string) =>
  value === undefined || (typeof value === "string" && value.trim() === "")
    ? Effect.fail(invalid(`${action} needs \`${name}\`.`))
    : Effect.succeed(value);

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const columnName = (board: KanbanBoardSnapshot, columnId: string) =>
  board.columns.find((column) => column.id === columnId)?.name ?? columnId;

const compactCard = (board: KanbanBoardSnapshot, card: KanbanCard): Out => ({
  id: card.id,
  number: card.number,
  title: card.title,
  column: columnName(board, card.columnId),
  priority: card.priority,
  labels: card.labelIds.map((id) => board.labels.find((label) => label.id === id)?.name ?? id),
  checklist: `${card.checklist.filter((item) => item.done).length}/${card.checklist.length}`,
  threads: card.linkedThreadIds.length,
});

const fullCard = (board: KanbanBoardSnapshot, card: KanbanCard): Out => ({
  ...compactCard(board, card),
  description: card.description,
  type: board.templates.find((template) => template.id === card.type)?.name ?? null,
  checklist: card.checklist.map(({ id, text, done }) => ({ id, text, done })),
  acceptanceCriteria: card.acceptanceCriteria.map(({ id, text, done }) => ({ id, text, done })),
  linkedThreadIds: [...card.linkedThreadIds],
});

const resolveColumn = Effect.fn("mcp.kanban.resolveColumn")(function* (
  board: KanbanBoardSnapshot,
  ref: string,
) {
  const column =
    board.columns.find((candidate) => candidate.id === ref) ??
    board.columns.find((candidate) => eq(candidate.name, ref)) ??
    board.columns.find((candidate) => candidate.role !== "none" && eq(candidate.role, ref));
  if (column === undefined) {
    return yield* invalid(
      `Unknown column "${ref}". Columns: ${board.columns.map((c) => `${c.name} (${c.role})`).join(", ")}.`,
    );
  }
  return column;
});

const run = Effect.fn("mcp.kanban.run")(
  function* (input: KanbanParameters) {
    const kanban = yield* KanbanService.KanbanService;
    const projects = yield* Project.ProjectService;
    const context = yield* loadCaller();
    const { kanban: settings } = context.scope;
    if (settings?.enabled === false) {
      return yield* invalid("The kanban board is turned off for agents in Settings.");
    }
    const threadId = context.scope.thread!.threadId;
    const actor = `agent:${threadId}` as KanbanActor;
    const action = input.action;

    // ponytail: the snapshot is the only board read; a per-board query when boards outgrow it.
    const snapshot = Effect.fn("mcp.kanban.snapshot")(function* () {
      const head = yield* Stream.runHead(kanban.subscribe());
      return head._tag === "Some" && head.value.kind === "snapshot" ? head.value.boards : [];
    });

    const resolveProject = Effect.fn("mcp.kanban.resolveProject")(function* () {
      const shells = yield* projects.listShells().pipe(Effect.mapError(unavailable));
      if (input.project === undefined) {
        if (settings?.defaultBoard === "ask") {
          return yield* invalid(
            `Ask the user which project's board to use, then pass it as \`project\`. Projects: ${shells.map((shell) => shell.title).join(", ")}.`,
          );
        }
        return yield* resolveProjectId(context, undefined);
      }
      const ref = input.project;
      const matches = shells.filter((shell) => shell.id === ref);
      const found = matches.length > 0 ? matches : shells.filter((shell) => eq(shell.title, ref));
      if (found.length !== 1) {
        return yield* invalid(
          `${found.length === 0 ? "No" : "Several"} projects match "${ref}". Use the project id.`,
        );
      }
      return found[0]!.id as ProjectId;
    });

    const projectBoard = Effect.fn("mcp.kanban.projectBoard")(function* (ensure: string | false) {
      const projectId = yield* resolveProject();
      if (ensure !== false) {
        const ensured = yield* kanban.boardEnsure({
          commandId: CommandId.make(`${ensure}:ensure`),
          projectId,
          actor,
        });
        const board = (yield* snapshot()).find((candidate) => candidate.id === ensured.boardId);
        if (board !== undefined) return board;
      }
      const board = (yield* snapshot()).find((candidate) => candidate.projectId === projectId);
      return (
        board ?? (yield* invalid("This project has no board yet. Create a card to start one."))
      );
    });

    const locateCard = Effect.fn("mcp.kanban.locateCard")(function* (ensure: string | false) {
      const boards = yield* snapshot();
      const ref = input.card?.trim();
      if (ref === undefined || ref === "") {
        for (const board of boards) {
          const card = board.cards.find((candidate) =>
            candidate.linkedThreadIds.includes(threadId),
          );
          if (card !== undefined) return { board, card };
        }
        return yield* invalid("Pass `card`: this thread is not linked to a card.");
      }
      const number = /^#?(\d+)$/.exec(ref)?.[1];
      if (number === undefined) {
        for (const board of boards) {
          const card = board.cards.find((candidate) => candidate.id === ref);
          if (card !== undefined) return { board, card };
        }
        return yield* invalid(`Card "${ref}" was not found. Use its id or #number.`);
      }
      const board = yield* projectBoard(ensure);
      const card = board.cards.find((candidate) => candidate.number === Number(number));
      return card === undefined
        ? yield* invalid(
            `Card #${number} is not on the "${board.title}" board (archived cards are hidden).`,
          )
        : { board, card };
    });

    const viewCard = Effect.fn("mcp.kanban.viewCard")(function* (cardId: string) {
      for (const board of yield* snapshot()) {
        const card = board.cards.find((candidate) => candidate.id === cardId);
        if (card !== undefined) return fullCard(board, card);
      }
      return { id: cardId };
    });

    const labelIds = Effect.fn("mcp.kanban.labelIds")(function* (
      board: KanbanBoardSnapshot,
      names: ReadonlyArray<string>,
      base: string,
    ) {
      const ids = [];
      for (const [index, name] of names.entries()) {
        const existing = board.labels.find((label) => eq(label.name, name));
        if (existing !== undefined) {
          ids.push(existing.id);
          continue;
        }
        const created = yield* kanban.labelUpsert({
          commandId: CommandId.make(`${base}:label:${index}`),
          boardId: board.id,
          name: name.trim(),
          color: "slate",
          actor,
        });
        ids.push(created.labelId!);
      }
      return ids;
    });

    const templateId = (board: KanbanBoardSnapshot, ref: string) => {
      const template =
        board.templates.find((candidate) => candidate.id === ref) ??
        board.templates.find((candidate) => eq(candidate.name, ref));
      return template === undefined
        ? Effect.fail(
            invalid(
              `Unknown type "${ref}". Types: ${board.templates.map((t) => t.name).join(", ")}.`,
            ),
          )
        : Effect.succeed(KanbanTemplateId.make(template.id));
    };

    switch (action) {
      case "list_boards": {
        const shells = yield* projects.listShells().pipe(Effect.mapError(unavailable));
        return {
          boards: (yield* snapshot()).map((board): Json => ({
            id: board.id,
            project: shells.find((shell) => shell.id === board.projectId)?.title ?? board.projectId,
            projectId: board.projectId,
            columns: board.columns.map((column) => ({
              name: column.name,
              role: column.role,
              cards: board.cards.filter((card) => card.columnId === column.id).length,
            })),
          })),
        } satisfies Out;
      }
      case "read_board": {
        const board = yield* projectBoard(false);
        const only =
          input.column === undefined ? undefined : (yield* resolveColumn(board, input.column)).id;
        const order = new Map(board.columns.map((column, index) => [column.id, index]));
        const cards = board.cards
          .filter(
            (card) =>
              (only === undefined || card.columnId === only) &&
              (input.label === undefined ||
                card.labelIds.some((id) =>
                  eq(board.labels.find((label) => label.id === id)?.name ?? "", input.label!),
                )) &&
              (input.text === undefined ||
                `${card.title}\n${card.description}`
                  .toLowerCase()
                  .includes(input.text.toLowerCase())),
          )
          .toSorted(
            (a, b) =>
              (order.get(a.columnId) ?? 0) - (order.get(b.columnId) ?? 0) ||
              (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0),
          );
        const shown = cards.slice(0, input.limit ?? 50);
        return {
          board: board.title,
          columns: board.columns.map((column) => ({
            id: column.id,
            name: column.name,
            role: column.role,
            wipLimit: column.wipLimit,
            cards: board.cards.filter((card) => card.columnId === column.id).length,
          })),
          labels: board.labels.map((label) => label.name),
          types: board.templates.map((template) => template.name),
          cards: shown.map((card) => compactCard(board, card)),
          matching: cards.length,
        } satisfies Out;
      }
      case "read_card": {
        const { board, card } = yield* locateCard(false);
        const detail = yield* kanban.getCard({ cardId: card.id });
        return {
          ...fullCard(board, detail.card),
          activity: detail.activity.slice(-10).map((event) => ({
            kind: event.kind,
            actor: event.actor,
            at: event.createdAt,
            payload: event.payload,
          })),
          threads: detail.threads.map((thread) => ({
            threadId: thread.threadId,
            title: thread.title,
            status: thread.status,
            branch: thread.branch,
            pullRequests: thread.pullRequests.map((pr) => pr.url),
          })),
        } satisfies Out;
      }
      default:
    }

    yield* assertNotLinked(context, "change this environment's kanban boards");
    const base =
      input.clientRequestId === undefined
        ? yield* newCommandId()
        : CommandId.make(`mcp:kanban:${context.scope.requestNamespace}:${input.clientRequestId}`);
    const commandId = (suffix: string) => CommandId.make(`${base}:${suffix}`);

    switch (action) {
      case "create_card": {
        const title = yield* need(input.title, "title", action);
        const board = yield* projectBoard(base);
        const column = yield* resolveColumn(board, input.column ?? "todo").pipe(
          Effect.catch((error) =>
            input.column === undefined && board.columns[0] !== undefined
              ? Effect.succeed(board.columns[0])
              : Effect.fail(error),
          ),
        );
        const added = (ops: ReadonlyArray<unknown> | undefined) =>
          ops === undefined
            ? undefined
            : applyChecklistOps([], ops as never).items.map(({ text, done }) => ({ text, done }));
        const created = yield* kanban.cardCreate({
          commandId: commandId("card"),
          boardId: board.id,
          columnId: KanbanColumnId.make(column.id),
          title,
          actor,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.type === undefined ? {} : { type: yield* templateId(board, input.type) }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.labels === undefined
            ? {}
            : { labelIds: yield* labelIds(board, input.labels, base) }),
          ...(input.checklist === undefined ? {} : { checklist: added(input.checklist)! }),
          ...(input.acceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: added(input.acceptanceCriteria)! }),
        });
        const linked: Out = {};
        if (input.linkSelf === true) {
          yield* kanban
            .cardLinkThread({
              commandId: commandId("link"),
              cardId: created.cardId!,
              threadId,
              actor,
            })
            .pipe(
              Effect.catchTags({
                KanbanError: (error) =>
                  Effect.sync(() => {
                    linked.linkError = error.message;
                  }),
              }),
            );
        }
        return { ...(yield* viewCard(created.cardId!)), ...linked } satisfies Out;
      }
      case "update_card": {
        const { board, card } = yield* locateCard(base);
        const checklist =
          input.checklist === undefined
            ? undefined
            : applyChecklistOps(card.checklist, input.checklist);
        const criteria =
          input.acceptanceCriteria === undefined
            ? undefined
            : applyChecklistOps(card.acceptanceCriteria, input.acceptanceCriteria);
        const error = checklist?.error ?? criteria?.error;
        if (error !== undefined) return yield* invalid(error);
        const ids = (items: ReadonlyArray<{ id?: string; text: string; done: boolean }>) =>
          items.map(({ id, text, done }) => ({
            ...(id === undefined ? {} : { id: id as never }),
            text,
            done,
          }));
        yield* kanban.cardUpdate({
          commandId: commandId("update"),
          cardId: card.id,
          actor,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.type === undefined ? {} : { type: yield* templateId(board, input.type) }),
          ...(input.labels === undefined
            ? {}
            : { labelIds: yield* labelIds(board, input.labels, base) }),
          ...(checklist === undefined ? {} : { checklist: ids(checklist.items) }),
          ...(criteria === undefined ? {} : { acceptanceCriteria: ids(criteria.items) }),
        });
        return (yield* viewCard(card.id)) satisfies Out;
      }
      case "move_card": {
        const { board, card } = yield* locateCard(base);
        const column = yield* resolveColumn(board, yield* need(input.column, "column", action));
        const moved = yield* kanban.cardMoveChecked({
          commandId: commandId("move"),
          cardId: card.id,
          columnId: KanbanColumnId.make(column.id),
          actor,
          summary: input.summary,
        });
        if ("refused" in moved) {
          return yield* invalid(
            `Not moved to ${column.name}: the board's definition of done is missing ${moved.refused.join("; ")}. Fix that, then call move_card again with \`summary\`.`,
          );
        }
        return (yield* viewCard(card.id)) satisfies Out;
      }
      case "comment": {
        const { card } = yield* locateCard(base);
        yield* kanban.cardComment({
          commandId: commandId("comment"),
          cardId: card.id,
          body: yield* need(input.body, "body", action),
          actor,
        });
        return { commented: card.number } satisfies Out;
      }
      case "link_thread":
      case "unlink_thread": {
        const { card } = yield* locateCard(base);
        const target = (input.threadId ?? threadId) as ThreadId;
        const link = action === "link_thread" ? kanban.cardLinkThread : kanban.cardUnlinkThread;
        yield* link({ commandId: commandId("thread"), cardId: card.id, threadId: target, actor });
        return (yield* viewCard(card.id)) satisfies Out;
      }
    }
  },
  Effect.catchTags({ KanbanError: (error) => Effect.fail(kanbanFailure(error)) }),
);

const reads = (action: KanbanParameters["action"]) =>
  action === "list_boards" || action === "read_board" || action === "read_card";

export const layer = McpToolAccess.toLayer(KanbanToolkit, {
  t3_kanban: McpToolAccess.either(
    (input: KanbanParameters) => reads(input.action),
    McpToolAccess.readsAsCaller(run),
    McpToolAccess.actsAsCaller(run),
  ),
});
