import {
  WS_METHODS,
  type KanbanBoardId,
  type KanbanBoardSnapshot,
  type KanbanCard,
  type KanbanCardId,
  type KanbanColumnId,
  type KanbanStreamItem,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export interface KanbanBoardState extends Omit<KanbanBoardSnapshot, "cards"> {
  readonly cards: ReadonlyMap<KanbanCardId, KanbanCard>;
}

export interface KanbanState {
  /** `null` until the first snapshot arrives. */
  readonly sequence: number | null;
  readonly boards: ReadonlyMap<KanbanBoardId, KanbanBoardState>;
}

export const EMPTY_KANBAN_STATE: KanbanState = { sequence: null, boards: new Map() };

export type KanbanApplyResult =
  | { readonly _tag: "applied"; readonly state: KanbanState }
  | { readonly _tag: "gap" };

const GAP: KanbanApplyResult = { _tag: "gap" };

const byOrderKey = (left: { orderKey: string; id: string }, right: typeof left) =>
  left.orderKey < right.orderKey
    ? -1
    : left.orderKey > right.orderKey
      ? 1
      : left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0;

/** Applies one stream item. A delta that does not directly follow the last applied sequence, or
    that names an unknown board, is a gap: the caller resubscribes for a fresh snapshot. */
export function applyKanbanStreamItem(
  state: KanbanState,
  item: KanbanStreamItem,
): KanbanApplyResult {
  if (item.kind === "snapshot") {
    return {
      _tag: "applied",
      state: {
        sequence: item.sequence,
        boards: new Map(
          item.boards.map((board) => [
            board.id,
            { ...board, cards: new Map(board.cards.map((card) => [card.id, card])) },
          ]),
        ),
      },
    };
  }
  if (state.sequence === null) return GAP;
  if (item.sequence <= state.sequence) return { _tag: "applied", state };
  if (item.sequence !== state.sequence + 1) return GAP;

  const boards = new Map(state.boards);
  const next = (): KanbanApplyResult => ({
    _tag: "applied",
    state: { sequence: item.sequence, boards },
  });
  if (item.kind === "board.upserted") {
    const existing = boards.get(item.board.id);
    boards.set(item.board.id, { ...item.board, cards: existing?.cards ?? new Map() });
    return next();
  }
  if (item.kind === "board.removed") {
    boards.delete(item.boardId);
    return next();
  }
  const boardId =
    item.kind === "card.upserted"
      ? item.card.boardId
      : item.kind === "column.upserted"
        ? item.column.boardId
        : item.boardId;
  const board = boards.get(boardId);
  if (board === undefined) return GAP;
  switch (item.kind) {
    case "card.upserted":
      boards.set(boardId, { ...board, cards: new Map(board.cards).set(item.card.id, item.card) });
      return next();
    case "card.removed": {
      const cards = new Map(board.cards);
      cards.delete(item.cardId);
      boards.set(boardId, { ...board, cards });
      return next();
    }
    case "column.upserted":
      boards.set(boardId, {
        ...board,
        columns: [
          ...board.columns.filter((column) => column.id !== item.column.id),
          item.column,
        ].sort(byOrderKey),
      });
      return next();
    case "column.removed":
      boards.set(boardId, {
        ...board,
        columns: board.columns.filter((column) => column.id !== item.columnId),
      });
      return next();
  }
}

/** Folds the stream into state; a gap reopens the subscription, whose snapshot replaces the state. */
export function kanbanStateStream<E, R>(
  open: () => Stream.Stream<KanbanStreamItem, E, R>,
): Stream.Stream<KanbanState, E, R> {
  const run = (): Stream.Stream<KanbanState, E, R> =>
    open().pipe(
      Stream.mapAccum(
        () => EMPTY_KANBAN_STATE,
        (state, item): readonly [KanbanState, ReadonlyArray<KanbanApplyResult>] => {
          const result = applyKanbanStreamItem(state, item);
          return [result._tag === "applied" ? result.state : state, [result]];
        },
      ),
      Stream.takeUntil((result) => result._tag === "gap"),
      Stream.flatMap((result) =>
        result._tag === "gap" ? Stream.suspend(run) : Stream.succeed(result.state),
      ),
    );
  return run();
}

export function selectKanbanBoardByProject(
  state: KanbanState,
  projectId: ProjectId,
): KanbanBoardState | undefined {
  for (const board of state.boards.values()) if (board.projectId === projectId) return board;
  return undefined;
}

/** Every column of the board, in order, with its cards in order. */
export function selectKanbanColumns(board: KanbanBoardState) {
  const cardsByColumn = new Map<KanbanColumnId, KanbanCard[]>();
  for (const card of [...board.cards.values()].sort(byOrderKey)) {
    const cards = cardsByColumn.get(card.columnId);
    if (cards === undefined) cardsByColumn.set(card.columnId, [card]);
    else cards.push(card);
  }
  return board.columns.map((column) => ({ column, cards: cardsByColumn.get(column.id) ?? [] }));
}

/** The card each linked thread belongs to; a thread links to at most one card. */
export function selectKanbanThreadCards(state: KanbanState): ReadonlyMap<ThreadId, KanbanCard> {
  const byThread = new Map<ThreadId, KanbanCard>();
  for (const board of state.boards.values()) {
    for (const card of board.cards.values()) {
      for (const threadId of card.linkedThreadIds) byThread.set(threadId, card);
    }
  }
  return byThread;
}

export function createKanbanEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One lane per environment keeps drags and edits applied in the order the user made them.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial",
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  } as const;
  const command = <
    TTag extends
      | typeof WS_METHODS.kanbanBoardEnsure
      | typeof WS_METHODS.kanbanBoardUpdate
      | typeof WS_METHODS.kanbanColumnCreate
      | typeof WS_METHODS.kanbanColumnUpdate
      | typeof WS_METHODS.kanbanColumnMove
      | typeof WS_METHODS.kanbanColumnDelete
      | typeof WS_METHODS.kanbanLabelUpsert
      | typeof WS_METHODS.kanbanLabelDelete
      | typeof WS_METHODS.kanbanTemplateUpsert
      | typeof WS_METHODS.kanbanTemplateDelete
      | typeof WS_METHODS.kanbanCardCreate
      | typeof WS_METHODS.kanbanCardUpdate
      | typeof WS_METHODS.kanbanCardMove
      | typeof WS_METHODS.kanbanCardArchive
      | typeof WS_METHODS.kanbanCardUnarchive
      | typeof WS_METHODS.kanbanCardDelete
      | typeof WS_METHODS.kanbanCardComment
      | typeof WS_METHODS.kanbanCardLinkThread
      | typeof WS_METHODS.kanbanCardUnlinkThread,
  >(
    tag: TTag,
    name: string,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:kanban:${name}`,
      tag,
      scheduler,
      concurrency,
    });
  return {
    live: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:kanban:live",
      subscribe: (_input: null) =>
        kanbanStateStream(() => subscribe(WS_METHODS.kanbanSubscribe, {})),
    }),
    card: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:kanban:card",
      tag: WS_METHODS.kanbanGetCard,
      idleTtlMs: 0,
    }),
    archived: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:kanban:archived",
      tag: WS_METHODS.kanbanListArchived,
      idleTtlMs: 0,
    }),
    ensureBoard: command(WS_METHODS.kanbanBoardEnsure, "board-ensure"),
    updateBoard: command(WS_METHODS.kanbanBoardUpdate, "board-update"),
    createColumn: command(WS_METHODS.kanbanColumnCreate, "column-create"),
    updateColumn: command(WS_METHODS.kanbanColumnUpdate, "column-update"),
    moveColumn: command(WS_METHODS.kanbanColumnMove, "column-move"),
    deleteColumn: command(WS_METHODS.kanbanColumnDelete, "column-delete"),
    upsertLabel: command(WS_METHODS.kanbanLabelUpsert, "label-upsert"),
    deleteLabel: command(WS_METHODS.kanbanLabelDelete, "label-delete"),
    upsertTemplate: command(WS_METHODS.kanbanTemplateUpsert, "template-upsert"),
    deleteTemplate: command(WS_METHODS.kanbanTemplateDelete, "template-delete"),
    createCard: command(WS_METHODS.kanbanCardCreate, "card-create"),
    updateCard: command(WS_METHODS.kanbanCardUpdate, "card-update"),
    moveCard: command(WS_METHODS.kanbanCardMove, "card-move"),
    archiveCard: command(WS_METHODS.kanbanCardArchive, "card-archive"),
    unarchiveCard: command(WS_METHODS.kanbanCardUnarchive, "card-unarchive"),
    deleteCard: command(WS_METHODS.kanbanCardDelete, "card-delete"),
    commentOnCard: command(WS_METHODS.kanbanCardComment, "card-comment"),
    linkCardThread: command(WS_METHODS.kanbanCardLinkThread, "card-link-thread"),
    unlinkCardThread: command(WS_METHODS.kanbanCardUnlinkThread, "card-unlink-thread"),
  };
}
