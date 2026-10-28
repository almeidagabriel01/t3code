import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const entityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

export const KanbanBoardId = entityId("KanbanBoardId");
export type KanbanBoardId = typeof KanbanBoardId.Type;
export const KanbanColumnId = entityId("KanbanColumnId");
export type KanbanColumnId = typeof KanbanColumnId.Type;
export const KanbanCardId = entityId("KanbanCardId");
export type KanbanCardId = typeof KanbanCardId.Type;
export const KanbanLabelId = entityId("KanbanLabelId");
export type KanbanLabelId = typeof KanbanLabelId.Type;
/** Also the card `type` a template stamps on its cards. */
export const KanbanTemplateId = entityId("KanbanTemplateId");
export type KanbanTemplateId = typeof KanbanTemplateId.Type;
export const KanbanChecklistItemId = entityId("KanbanChecklistItemId");
export type KanbanChecklistItemId = typeof KanbanChecklistItemId.Type;
export const KanbanCardEventId = entityId("KanbanCardEventId");
export type KanbanCardEventId = typeof KanbanCardEventId.Type;

export const KanbanColumnRole = Schema.Literals([
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
  "none",
]);
export type KanbanColumnRole = typeof KanbanColumnRole.Type;

export const KanbanPriority = Schema.Literals(["urgent", "high", "medium", "low", "none"]);
export type KanbanPriority = typeof KanbanPriority.Type;

/** `user`, `automation`, or `agent:<threadId>`. */
export const KanbanActor = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(user|automation|agent:.+)$/),
);
export type KanbanActor = typeof KanbanActor.Type;

const KanbanColor = Schema.String.check(Schema.isMaxLength(64));
const KanbanName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const KANBAN_DESCRIPTION_MAX_CHARS = 100_000;
const KanbanText = Schema.String.check(Schema.isMaxLength(KANBAN_DESCRIPTION_MAX_CHARS));

export const KanbanColumn = Schema.Struct({
  id: KanbanColumnId,
  boardId: KanbanBoardId,
  name: KanbanName,
  color: KanbanColor,
  orderKey: Schema.String,
  wipLimit: Schema.NullOr(PositiveInt),
  role: KanbanColumnRole,
});
export type KanbanColumn = typeof KanbanColumn.Type;

export const KanbanLabel = Schema.Struct({
  id: KanbanLabelId,
  name: KanbanName,
  color: KanbanColor,
});
export type KanbanLabel = typeof KanbanLabel.Type;

export const KanbanChecklistItem = Schema.Struct({
  id: KanbanChecklistItemId,
  text: KanbanText,
  done: Schema.Boolean,
});
export type KanbanChecklistItem = typeof KanbanChecklistItem.Type;

export const KanbanTemplate = Schema.Struct({
  id: KanbanTemplateId,
  name: KanbanName,
  icon: KanbanColor,
  color: KanbanColor,
  checklist: Schema.Array(KanbanText),
  acceptanceCriteria: Schema.Array(KanbanText),
  labelIds: Schema.Array(KanbanLabelId),
  priority: KanbanPriority,
});
export type KanbanTemplate = typeof KanbanTemplate.Type;

export const KanbanAutomations = Schema.Struct({
  threadStarted: Schema.Boolean,
  runCompleted: Schema.Boolean,
  prMerged: Schema.Boolean,
  definitionOfDone: Schema.Boolean,
});
export type KanbanAutomations = typeof KanbanAutomations.Type;

const KanbanTemplateDraft = Schema.Struct({
  name: KanbanName,
  icon: KanbanColor,
  color: KanbanColor,
  priority: KanbanPriority,
  checklist: Schema.Array(KanbanText),
  acceptanceCriteria: Schema.Array(KanbanText),
});

/** The columns and card templates a new board starts with. */
export const KanbanDefaultTemplate = Schema.Struct({
  columns: Schema.Array(
    Schema.Struct({
      name: KanbanName,
      color: KanbanColor,
      role: KanbanColumnRole,
      wipLimit: Schema.NullOr(PositiveInt),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  cardTemplates: Schema.Array(KanbanTemplateDraft).check(Schema.isMaxLength(30)),
}).check(
  Schema.makeFilter(
    (template) => {
      const roles = template.columns.map((column) => column.role).filter((role) => role !== "none");
      return new Set(roles).size === roles.length || "Each role can belong to one column only.";
    },
    { identifier: "KanbanDefaultTemplateRoles" },
  ),
);
export type KanbanDefaultTemplate = typeof KanbanDefaultTemplate.Type;

export const BUILT_IN_KANBAN_TEMPLATE: KanbanDefaultTemplate = {
  columns: [
    { name: "Backlog", color: "slate", role: "backlog", wipLimit: null },
    { name: "To do", color: "blue", role: "todo", wipLimit: null },
    { name: "In progress", color: "amber", role: "in-progress", wipLimit: null },
    { name: "Review", color: "violet", role: "review", wipLimit: null },
    { name: "Done", color: "green", role: "done", wipLimit: null },
  ],
  cardTemplates: [
    {
      name: "Bug",
      icon: "bug",
      color: "red",
      priority: "high",
      checklist: ["Reproduce the bug", "Find the root cause", "Fix it", "Add a regression test"],
      acceptanceCriteria: ["The bug no longer reproduces", "A test covers the failing case"],
    },
    {
      name: "Feature",
      icon: "sparkles",
      color: "blue",
      priority: "medium",
      checklist: ["Clarify the behavior", "Implement", "Add tests", "Update docs if needed"],
      acceptanceCriteria: ["The feature works as described", "Tests cover the new behavior"],
    },
    {
      name: "Refactor",
      icon: "wrench",
      color: "violet",
      priority: "low",
      checklist: ["Confirm current behavior with tests", "Refactor", "Run the full checks"],
      acceptanceCriteria: ["Behavior is unchanged", "Checks pass"],
    },
    {
      name: "Chore",
      icon: "broom",
      color: "slate",
      priority: "low",
      checklist: ["Do the work", "Verify nothing else broke"],
      acceptanceCriteria: ["The chore is complete"],
    },
  ],
};

export const KanbanEstimate = Schema.Struct({
  value: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  unit: Schema.Literals(["points", "hours"]),
});
export type KanbanEstimate = typeof KanbanEstimate.Type;

export const KanbanBoard = Schema.Struct({
  id: KanbanBoardId,
  projectId: ProjectId,
  title: KanbanName,
  columns: Schema.Array(KanbanColumn),
  labels: Schema.Array(KanbanLabel),
  templates: Schema.Array(KanbanTemplate),
  automations: KanbanAutomations,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type KanbanBoard = typeof KanbanBoard.Type;

export const KanbanCard = Schema.Struct({
  id: KanbanCardId,
  boardId: KanbanBoardId,
  columnId: KanbanColumnId,
  orderKey: Schema.String,
  number: PositiveInt,
  title: KanbanName,
  description: KanbanText,
  type: Schema.NullOr(KanbanTemplateId),
  priority: KanbanPriority,
  labelIds: Schema.Array(KanbanLabelId),
  dueAt: Schema.NullOr(IsoDateTime),
  estimate: Schema.NullOr(KanbanEstimate),
  checklist: Schema.Array(KanbanChecklistItem),
  acceptanceCriteria: Schema.Array(KanbanChecklistItem),
  blocks: Schema.Array(KanbanCardId),
  blockedBy: Schema.Array(KanbanCardId),
  linkedThreadIds: Schema.Array(ThreadId),
  archivedAt: Schema.NullOr(IsoDateTime),
  createdBy: KanbanActor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type KanbanCard = typeof KanbanCard.Type;

export const KanbanBoardSnapshot = Schema.Struct({
  ...KanbanBoard.fields,
  /** Non-archived cards only, without activity. */
  cards: Schema.Array(KanbanCard),
});
export type KanbanBoardSnapshot = typeof KanbanBoardSnapshot.Type;

const KANBAN_CARD_EVENT_KINDS = [
  "comment",
  "created",
  "moved",
  "field-changed",
  "linked",
  "unlinked",
  "archived",
  "unarchived",
  "automation",
  "dod-refused",
] as const;

export const KanbanCardEvent = Schema.Struct({
  id: KanbanCardEventId,
  cardId: KanbanCardId,
  kind: Schema.Literals(KANBAN_CARD_EVENT_KINDS),
  actor: KanbanActor,
  payload: Schema.Json,
  createdAt: IsoDateTime,
});
export type KanbanCardEvent = typeof KanbanCardEvent.Type;

const sequence = { sequence: NonNegativeInt };

export const KanbanStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    ...sequence,
    boards: Schema.Array(KanbanBoardSnapshot),
  }),
  Schema.Struct({ kind: Schema.Literal("board.upserted"), ...sequence, board: KanbanBoard }),
  Schema.Struct({ kind: Schema.Literal("board.removed"), ...sequence, boardId: KanbanBoardId }),
  Schema.Struct({ kind: Schema.Literal("card.upserted"), ...sequence, card: KanbanCard }),
  Schema.Struct({
    kind: Schema.Literal("card.removed"),
    ...sequence,
    boardId: KanbanBoardId,
    cardId: KanbanCardId,
  }),
  Schema.Struct({ kind: Schema.Literal("column.upserted"), ...sequence, column: KanbanColumn }),
  Schema.Struct({
    kind: Schema.Literal("column.removed"),
    ...sequence,
    boardId: KanbanBoardId,
    columnId: KanbanColumnId,
  }),
]);
export type KanbanStreamItem = typeof KanbanStreamItem.Type;

export const KanbanSubscribeInput = Schema.Struct({});
export type KanbanSubscribeInput = typeof KanbanSubscribeInput.Type;

/** Everything but `threadId` is derived from the projection at read time; null when the thread is gone. */
export const KanbanLinkedThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  pullRequests: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      number: Schema.NullOr(Schema.Int),
      state: Schema.NullOr(Schema.String),
    }),
  ),
});
export type KanbanLinkedThread = typeof KanbanLinkedThread.Type;

export const KanbanGetCardInput = Schema.Struct({ cardId: KanbanCardId });
export type KanbanGetCardInput = typeof KanbanGetCardInput.Type;
export const KanbanGetCardResult = Schema.Struct({
  card: KanbanCard,
  activity: Schema.Array(KanbanCardEvent),
  threads: Schema.Array(KanbanLinkedThread),
  /** `null` when any usage is partial or unpriced, or nothing is linked. */
  costUsd: Schema.NullOr(Schema.Number),
  totalTokens: Schema.NullOr(NonNegativeInt),
  durationMs: Schema.NullOr(NonNegativeInt),
});
export type KanbanGetCardResult = typeof KanbanGetCardResult.Type;

export const KanbanListArchivedInput = Schema.Struct({ boardId: KanbanBoardId });
export type KanbanListArchivedInput = typeof KanbanListArchivedInput.Type;
export const KanbanListArchivedResult = Schema.Struct({ cards: Schema.Array(KanbanCard) });
export type KanbanListArchivedResult = typeof KanbanListArchivedResult.Type;

const command = {
  commandId: CommandId,
  actor: Schema.optionalKey(KanbanActor),
};

export const KanbanBoardEnsureInput = Schema.Struct({ ...command, projectId: ProjectId });
export const KanbanBoardUpdateInput = Schema.Struct({
  ...command,
  boardId: KanbanBoardId,
  title: Schema.optionalKey(KanbanName),
  automations: Schema.optionalKey(
    Schema.Struct({
      threadStarted: Schema.optionalKey(Schema.Boolean),
      runCompleted: Schema.optionalKey(Schema.Boolean),
      prMerged: Schema.optionalKey(Schema.Boolean),
      definitionOfDone: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

export const KanbanColumnCreateInput = Schema.Struct({
  ...command,
  boardId: KanbanBoardId,
  name: KanbanName,
  color: Schema.optionalKey(KanbanColor),
  wipLimit: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  role: Schema.optionalKey(KanbanColumnRole),
  /** Omit both to append. */
  beforeColumnId: Schema.optionalKey(KanbanColumnId),
  afterColumnId: Schema.optionalKey(KanbanColumnId),
});
export const KanbanColumnUpdateInput = Schema.Struct({
  ...command,
  columnId: KanbanColumnId,
  name: Schema.optionalKey(KanbanName),
  color: Schema.optionalKey(KanbanColor),
  wipLimit: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  role: Schema.optionalKey(KanbanColumnRole),
});
export const KanbanColumnMoveInput = Schema.Struct({
  ...command,
  columnId: KanbanColumnId,
  beforeColumnId: Schema.optionalKey(KanbanColumnId),
  afterColumnId: Schema.optionalKey(KanbanColumnId),
});
export const KanbanColumnDeleteInput = Schema.Struct({
  ...command,
  columnId: KanbanColumnId,
  /** Receives every card, archived ones included. */
  targetColumnId: KanbanColumnId,
});

export const KanbanLabelUpsertInput = Schema.Struct({
  ...command,
  boardId: KanbanBoardId,
  labelId: Schema.optionalKey(KanbanLabelId),
  name: KanbanName,
  color: KanbanColor,
});
export const KanbanLabelDeleteInput = Schema.Struct({
  ...command,
  boardId: KanbanBoardId,
  labelId: KanbanLabelId,
});

export const KanbanTemplateUpsertInput = Schema.Struct({
  ...command,
  boardId: KanbanBoardId,
  templateId: Schema.optionalKey(KanbanTemplateId),
  name: KanbanName,
  icon: KanbanColor,
  color: KanbanColor,
  checklist: Schema.Array(KanbanText),
  acceptanceCriteria: Schema.Array(KanbanText),
  labelIds: Schema.Array(KanbanLabelId),
  priority: KanbanPriority,
});
export const KanbanTemplateDeleteInput = Schema.Struct({
  ...command,
  boardId: KanbanBoardId,
  templateId: KanbanTemplateId,
});

/** Items with an `id` keep it; items without get a fresh one. */
const ChecklistInput = Schema.Array(
  Schema.Struct({
    id: Schema.optionalKey(KanbanChecklistItemId),
    text: KanbanText,
    done: Schema.Boolean,
  }),
);

export const KanbanCardCreateInput = Schema.Struct({
  ...command,
  boardId: KanbanBoardId,
  /** Defaults to the backlog column, else the first. */
  columnId: Schema.optionalKey(KanbanColumnId),
  title: KanbanName,
  description: Schema.optionalKey(KanbanText),
  /** A template id; its checklist, criteria, labels, and priority seed what the input omits. */
  type: Schema.optionalKey(Schema.NullOr(KanbanTemplateId)),
  priority: Schema.optionalKey(KanbanPriority),
  labelIds: Schema.optionalKey(Schema.Array(KanbanLabelId)),
  dueAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  estimate: Schema.optionalKey(Schema.NullOr(KanbanEstimate)),
  checklist: Schema.optionalKey(ChecklistInput),
  acceptanceCriteria: Schema.optionalKey(ChecklistInput),
});
export const KanbanCardUpdateInput = Schema.Struct({
  ...command,
  cardId: KanbanCardId,
  title: Schema.optionalKey(KanbanName),
  description: Schema.optionalKey(KanbanText),
  type: Schema.optionalKey(Schema.NullOr(KanbanTemplateId)),
  priority: Schema.optionalKey(KanbanPriority),
  labelIds: Schema.optionalKey(Schema.Array(KanbanLabelId)),
  dueAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  estimate: Schema.optionalKey(Schema.NullOr(KanbanEstimate)),
  checklist: Schema.optionalKey(ChecklistInput),
  acceptanceCriteria: Schema.optionalKey(ChecklistInput),
  /** Replaces the set; the other card's `blockedBy` follows. */
  blocks: Schema.optionalKey(Schema.Array(KanbanCardId)),
  blockedBy: Schema.optionalKey(Schema.Array(KanbanCardId)),
});
export const KanbanCardMoveInput = Schema.Struct({
  ...command,
  cardId: KanbanCardId,
  columnId: KanbanColumnId,
  /** Omit both to drop at the bottom of the column. */
  beforeCardId: Schema.optionalKey(KanbanCardId),
  afterCardId: Schema.optionalKey(KanbanCardId),
});
export const KanbanCardIdInput = Schema.Struct({ ...command, cardId: KanbanCardId });
export const KanbanCardCommentInput = Schema.Struct({
  ...command,
  cardId: KanbanCardId,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(KANBAN_DESCRIPTION_MAX_CHARS)),
});
export const KanbanCardThreadLinkInput = Schema.Struct({
  ...command,
  cardId: KanbanCardId,
  threadId: ThreadId,
});

export type KanbanBoardEnsureInput = typeof KanbanBoardEnsureInput.Type;
export type KanbanBoardUpdateInput = typeof KanbanBoardUpdateInput.Type;
export type KanbanColumnCreateInput = typeof KanbanColumnCreateInput.Type;
export type KanbanColumnUpdateInput = typeof KanbanColumnUpdateInput.Type;
export type KanbanColumnMoveInput = typeof KanbanColumnMoveInput.Type;
export type KanbanColumnDeleteInput = typeof KanbanColumnDeleteInput.Type;
export type KanbanLabelUpsertInput = typeof KanbanLabelUpsertInput.Type;
export type KanbanLabelDeleteInput = typeof KanbanLabelDeleteInput.Type;
export type KanbanTemplateUpsertInput = typeof KanbanTemplateUpsertInput.Type;
export type KanbanTemplateDeleteInput = typeof KanbanTemplateDeleteInput.Type;
export type KanbanCardCreateInput = typeof KanbanCardCreateInput.Type;
export type KanbanCardUpdateInput = typeof KanbanCardUpdateInput.Type;
export type KanbanCardMoveInput = typeof KanbanCardMoveInput.Type;
export type KanbanCardIdInput = typeof KanbanCardIdInput.Type;
export type KanbanCardCommentInput = typeof KanbanCardCommentInput.Type;
export type KanbanCardThreadLinkInput = typeof KanbanCardThreadLinkInput.Type;

/** `sequence` is the last delta this command published; ids name what it created or touched. */
export const KanbanMutationResult = Schema.Struct({
  sequence: NonNegativeInt,
  boardId: Schema.optionalKey(KanbanBoardId),
  columnId: Schema.optionalKey(KanbanColumnId),
  labelId: Schema.optionalKey(KanbanLabelId),
  templateId: Schema.optionalKey(KanbanTemplateId),
  cardId: Schema.optionalKey(KanbanCardId),
  number: Schema.optionalKey(PositiveInt),
});
export type KanbanMutationResult = typeof KanbanMutationResult.Type;

export class KanbanError extends Schema.TaggedError<KanbanError>()("KanbanError", {
  message: Schema.String,
  kind: Schema.Literals(["not_found", "invalid", "conflict", "internal"]),
  cause: Schema.optional(Schema.Defect()),
}) {}
