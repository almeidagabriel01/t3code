// @effect-diagnostics globalDate:off - Local calendar-day conversion for date inputs, outside an Effect runtime.
import type {
  EnvironmentId,
  KanbanBoardId,
  KanbanCard,
  KanbanCardContextRecord,
  KanbanCardEvent,
  KanbanCardId,
  KanbanChecklistItem,
  KanbanColumn,
  KanbanColumnId,
  KanbanColumnRole,
  KanbanDefaultTemplate,
  KanbanPriority,
  ProjectId,
} from "@t3tools/contracts";
import type { KanbanBoardState, KanbanState } from "./kanban.ts";

export const KANBAN_PRIORITIES: ReadonlyArray<KanbanPriority> = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

export const KANBAN_ROLES: ReadonlyArray<KanbanColumnRole> = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
  "none",
];

export const KANBAN_ROLE_LABELS: Record<KanbanColumnRole, string> = {
  backlog: "Backlog",
  todo: "To do",
  "in-progress": "In progress",
  review: "Review",
  done: "Done",
  none: "No role",
};

export const KANBAN_PRIORITY_LABELS: Record<KanbanPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};

export const KANBAN_COLORS: Record<string, string> = {
  slate: "#64748b",
  blue: "#3b82f6",
  amber: "#f59e0b",
  violet: "#8b5cf6",
  green: "#22c55e",
  red: "#ef4444",
  pink: "#ec4899",
  teal: "#14b8a6",
  orange: "#f97316",
};

export function kanbanColor(color: string): string {
  return KANBAN_COLORS[color] ?? (/^#[0-9a-f]{3,8}$/i.test(color) ? color : KANBAN_COLORS.slate!);
}

export interface GlobalCard {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly boardId: KanbanBoardId;
  readonly card: KanbanCard;
  readonly role: KanbanColumnRole;
}

export interface GlobalBoard {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
}

export function checklistProgress(items: ReadonlyArray<Pick<KanbanChecklistItem, "done">>) {
  return { done: items.filter((item) => item.done).length, total: items.length };
}

export function isOverdue(card: Pick<KanbanCard, "dueAt">, now: number): boolean {
  return card.dueAt !== null && Date.parse(card.dueAt) < now;
}

export function isWipExceeded(column: Pick<KanbanColumn, "wipLimit">, count: number): boolean {
  return column.wipLimit !== null && count > column.wipLimit;
}

export function collectGlobalBoards(
  states: ReadonlyArray<{ environmentId: EnvironmentId; state: KanbanState | null }>,
): ReadonlyArray<GlobalBoard> {
  return states.flatMap(({ environmentId, state }) =>
    state === null ? [] : [...state.boards.values()].map((board) => ({ environmentId, board })),
  );
}

export function collectGlobalCards(boards: ReadonlyArray<GlobalBoard>): ReadonlyArray<GlobalCard> {
  return boards.flatMap(({ environmentId, board }) => {
    const roleByColumn = new Map(board.columns.map((column) => [column.id, column.role]));
    return [...board.cards.values()].map((card) => ({
      environmentId,
      projectId: board.projectId,
      boardId: board.id,
      card,
      role: roleByColumn.get(card.columnId) ?? "none",
    }));
  });
}

export interface GlobalFilters {
  readonly projects: ReadonlyArray<string>;
  readonly label: string | null;
  readonly priority: KanbanPriority | null;
  readonly type: string | null;
  readonly hasAgent: boolean;
  readonly text: string;
}

export const EMPTY_FILTERS: GlobalFilters = {
  projects: [],
  label: null,
  priority: null,
  type: null,
  hasAgent: false,
  text: "",
};

export function boardScopeKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

/** Labels and templates are per board, so they filter by name and by template name. */
export function filterGlobalCards(
  cards: ReadonlyArray<GlobalCard>,
  boards: ReadonlyArray<GlobalBoard>,
  filters: GlobalFilters,
): ReadonlyArray<GlobalCard> {
  const boardById = new Map(boards.map((entry) => [entry.board.id, entry.board]));
  const text = filters.text.trim().toLowerCase();
  return cards.filter((entry) => {
    const { card } = entry;
    if (
      filters.projects.length > 0 &&
      !filters.projects.includes(boardScopeKey(entry.environmentId, entry.projectId))
    ) {
      return false;
    }
    if (filters.priority !== null && card.priority !== filters.priority) return false;
    if (filters.hasAgent && card.linkedThreadIds.length === 0) return false;
    const board = boardById.get(entry.boardId);
    if (filters.type !== null) {
      const name = board?.templates.find((template) => template.id === card.type)?.name;
      if (name?.toLowerCase() !== filters.type.toLowerCase()) return false;
    }
    if (filters.label !== null) {
      const wanted = filters.label.toLowerCase();
      const has = card.labelIds.some(
        (id) => board?.labels.find((label) => label.id === id)?.name.toLowerCase() === wanted,
      );
      if (!has) return false;
    }
    if (text.length > 0) {
      const haystack = `#${card.number} ${card.title} ${card.description}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
}

export interface RoleColumn {
  readonly role: KanbanColumnRole;
  readonly cards: ReadonlyArray<GlobalCard>;
}

const MERGED_ROLES: ReadonlyArray<KanbanColumnRole> = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
];

/** Merged mode: one column per role, plus a trailing one for cards in role-less columns. */
export function groupCardsByRole(cards: ReadonlyArray<GlobalCard>): ReadonlyArray<RoleColumn> {
  const columns = [...MERGED_ROLES, "none" as const].map((role) => ({
    role,
    cards: cards.filter((entry) => entry.role === role),
  }));
  return columns.filter((column) => column.role !== "none" || column.cards.length > 0);
}

export interface ProjectLane {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly cards: ReadonlyArray<GlobalCard>;
}

export function groupCardsByProject(
  boards: ReadonlyArray<GlobalBoard>,
  cards: ReadonlyArray<GlobalCard>,
): ReadonlyArray<ProjectLane> {
  return boards.map(({ environmentId, board }) => ({
    key: boardScopeKey(environmentId, board.projectId),
    environmentId,
    board,
    cards: cards.filter((entry) => entry.boardId === board.id),
  }));
}

export interface ColumnCards {
  readonly columnId: KanbanColumnId;
  readonly cardIds: ReadonlyArray<KanbanCardId>;
}

export interface CardMove {
  readonly cardId: KanbanCardId;
  readonly columnId: KanbanColumnId;
  readonly beforeCardId?: KanbanCardId;
  readonly afterCardId?: KanbanCardId;
}

/** `overId` is a card or a column. Dropping on a column appends; on a card it takes that card's place. */
export function dropToMove(
  activeId: KanbanCardId,
  overId: string,
  columns: ReadonlyArray<ColumnCards>,
): CardMove | null {
  const from = columns.find((column) => column.cardIds.includes(activeId));
  if (from === undefined) return null;
  const overColumn = columns.find((column) => column.columnId === overId);
  if (overColumn !== undefined) {
    const last = overColumn.cardIds.filter((id) => id !== activeId).at(-1);
    return overColumn.columnId === from.columnId && last === undefined
      ? null
      : {
          cardId: activeId,
          columnId: overColumn.columnId,
          ...(last === undefined ? {} : { afterCardId: last }),
        };
  }
  const target = columns.find((column) => column.cardIds.includes(overId as KanbanCardId));
  if (target === undefined || overId === activeId) return null;
  const over = overId as KanbanCardId;
  if (target.columnId !== from.columnId) {
    return { cardId: activeId, columnId: target.columnId, beforeCardId: over };
  }
  const movingDown = from.cardIds.indexOf(activeId) < from.cardIds.indexOf(over);
  return movingDown
    ? { cardId: activeId, columnId: target.columnId, afterCardId: over }
    : { cardId: activeId, columnId: target.columnId, beforeCardId: over };
}

/** The columns as they will look once the server applies `move`. */
export function applyMoveLocally(
  columns: ReadonlyArray<ColumnCards>,
  move: CardMove,
): ReadonlyArray<ColumnCards> {
  return columns.map((column) => {
    const rest = column.cardIds.filter((id) => id !== move.cardId);
    if (column.columnId !== move.columnId) return { ...column, cardIds: rest };
    const anchor = move.beforeCardId ?? move.afterCardId;
    const index = anchor === undefined ? -1 : rest.indexOf(anchor);
    if (index < 0) return { ...column, cardIds: [...rest, move.cardId] };
    const at = move.beforeCardId === undefined ? index + 1 : index;
    return { ...column, cardIds: [...rest.slice(0, at), move.cardId, ...rest.slice(at)] };
  });
}

/** The user's manual drag is allowed; this is the reason to warn when it skips the definition of done. */
export function definitionOfDoneWarning(
  board: Pick<KanbanBoardState, "automations">,
  card: Pick<KanbanCard, "checklist">,
  target: Pick<KanbanColumn, "role" | "name">,
): string | null {
  if (!board.automations.definitionOfDone) return null;
  if (target.role !== "review" && target.role !== "done") return null;
  const { done, total } = checklistProgress(card.checklist);
  return done < total
    ? `${total - done} checklist item${total - done === 1 ? "" : "s"} still open in ${target.name}.`
    : null;
}

export function kanbanCardContextRecord(
  card: KanbanCard,
  board: Pick<KanbanBoardState, "labels" | "templates">,
): KanbanCardContextRecord {
  const clamp = (text: string, max: number) => text.slice(0, max);
  const items = (list: ReadonlyArray<KanbanChecklistItem>) =>
    list.slice(0, 200).map((item) => ({ text: clamp(item.text, 2_048), done: item.done }));
  const labelNames = card.labelIds.flatMap((id) => {
    const name = board.labels.find((label) => label.id === id)?.name;
    return name === undefined ? [] : [clamp(name, 200)];
  });
  const type = board.templates.find((template) => template.id === card.type)?.name ?? null;
  return {
    version: 1,
    contextId: `kanban-card-${card.number}` as KanbanCardContextRecord["contextId"],
    label: clamp(`#${card.number} ${card.title}`, 200),
    kind: "kanban-card",
    cardId: card.id,
    boardId: card.boardId,
    number: card.number,
    title: clamp(card.title, 200),
    description: clamp(card.description, 16_000),
    checklist: items(card.checklist),
    acceptanceCriteria: items(card.acceptanceCriteria),
    type: type === null ? null : clamp(type, 200),
    priority: card.priority,
    labels: labelNames.slice(0, 50),
  };
}

/** `YYYY-MM-DD` of the local calendar day; empty for no due date. */
export function dueAtToInput(dueAt: string | null): string {
  if (dueAt === null) return "";
  const date = new Date(dueAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local noon keeps the day stable in every timezone. */
export function inputToDueAt(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function moveChecklistItem<T>(items: ReadonlyArray<T>, index: number, delta: -1 | 1) {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function describeCardEvent(
  event: Pick<KanbanCardEvent, "kind" | "payload">,
  columnName: (columnId: string) => string,
): string {
  const payload: Record<string, unknown> =
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  switch (event.kind) {
    case "comment":
      return typeof payload.body === "string" ? payload.body : "";
    case "created":
      return "Created the card";
    case "moved":
      return typeof payload.toColumnId === "string"
        ? `Moved to ${columnName(payload.toColumnId)}`
        : "Moved the card";
    case "field-changed":
      return Array.isArray(payload.fields)
        ? `Changed ${(payload.fields as unknown[]).join(", ")}`
        : "Edited the card";
    case "linked":
      return "Linked a thread";
    case "unlinked":
      return "Unlinked a thread";
    case "archived":
      return "Archived the card";
    case "unarchived":
      return "Restored the card";
    case "dod-refused":
      return Array.isArray(payload.missing)
        ? `Move refused, missing: ${(payload.missing as unknown[]).join(", ")}`
        : "Move refused by the definition of done";
    case "automation":
      return typeof payload.message === "string" ? payload.message : "Moved by an automation";
  }
}

export function findCardInBoards(boards: ReadonlyArray<GlobalBoard>, cardId: string) {
  for (const { environmentId, board } of boards) {
    const card = board.cards.get(cardId as KanbanCardId);
    if (card !== undefined) return { environmentId, board, card };
  }
  return null;
}

/** A reason the default template cannot be saved, or null. */
export function validateDefaultTemplate(template: KanbanDefaultTemplate): string | null {
  if (template.columns.length === 0) return "Add at least one column.";
  if (template.columns.some((column) => column.name.trim().length === 0)) {
    return "Every column needs a name.";
  }
  const seen = new Set<KanbanColumnRole>();
  for (const { role } of template.columns) {
    if (role === "none") continue;
    if (seen.has(role)) return `Only one column can have the ${KANBAN_ROLE_LABELS[role]} role.`;
    seen.add(role);
  }
  return null;
}
