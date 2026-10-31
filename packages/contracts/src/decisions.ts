import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A decision is a durable question an agent puts to the user. The agent keeps working or ends its
 * turn; the answer reaches the requesting thread later as a queued message. Silence never approves.
 */
export const DECISION_TITLE_MAX_LENGTH = 120;
export const DECISION_CONTEXT_MAX_LENGTH = 4_000;
export const DECISION_OPTION_LABEL_MAX_LENGTH = 80;
export const DECISION_OPTION_CONSEQUENCE_MAX_LENGTH = 200;
export const DECISION_MAX_OPTIONS = 10;
export const DECISION_ANSWER_TEXT_MAX_LENGTH = 2_000;

export const DecisionId = TrimmedNonEmptyString.pipe(Schema.brand("DecisionId"));
export type DecisionId = typeof DecisionId.Type;

export const DecisionOption = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(DECISION_OPTION_LABEL_MAX_LENGTH)),
  /** What choosing this option sets in motion; shown to the user, not interpreted. */
  consequence: Schema.optional(
    Schema.String.check(Schema.isMaxLength(DECISION_OPTION_CONSEQUENCE_MAX_LENGTH)),
  ),
});
export type DecisionOption = typeof DecisionOption.Type;

export const DecisionStatus = Schema.Literals(["open", "answered", "expired", "withdrawn"]);
export type DecisionStatus = typeof DecisionStatus.Type;

export const DecisionAnswer = Schema.Struct({
  optionId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(DECISION_ANSWER_TEXT_MAX_LENGTH))),
});
export type DecisionAnswer = typeof DecisionAnswer.Type;

export const Decision = Schema.Struct({
  id: DecisionId,
  fromThreadId: ThreadId,
  /** The requesting thread's title when it asked, so the inbox reads without a lookup. */
  threadTitle: Schema.String,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(DECISION_TITLE_MAX_LENGTH)),
  /** Markdown. */
  context: Schema.String.check(Schema.isMaxLength(DECISION_CONTEXT_MAX_LENGTH)),
  options: Schema.Array(DecisionOption).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DECISION_MAX_OPTIONS),
  ),
  /** An option id. */
  recommended: Schema.optional(Schema.String),
  expiresAt: Schema.optional(IsoDateTime),
  /** `withdrawn` is the agent taking it back or the user dismissing it. */
  status: DecisionStatus,
  answer: Schema.optional(DecisionAnswer),
  answeredAt: Schema.optional(IsoDateTime),
  /** When the outcome reached the requesting thread; absent while pending or when the thread is gone. */
  deliveredAt: Schema.optional(IsoDateTime),
  /** Set when the decision mirrors a provider approval; answering responds to that request. */
  approvalRequestId: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});
export type Decision = typeof Decision.Type;

export const DecisionsListInput = Schema.Struct({ threadId: Schema.optional(ThreadId) });
export type DecisionsListInput = typeof DecisionsListInput.Type;

export const DecisionsListResult = Schema.Struct({ decisions: Schema.Array(Decision) });
export type DecisionsListResult = typeof DecisionsListResult.Type;

export const DecisionsSubscribeInput = Schema.Struct({});
export type DecisionsSubscribeInput = typeof DecisionsSubscribeInput.Type;

/** The first event is a snapshot of every open decision and the most recent settled ones. */
export const DecisionsEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), decisions: Schema.Array(Decision) }),
  Schema.Struct({ type: Schema.Literal("upserted"), decision: Decision }),
]);
export type DecisionsEvent = typeof DecisionsEvent.Type;

/** An option id, free text, or both; text alone is the answer when no option fits. */
export const DecisionsAnswerInput = Schema.Struct({
  decisionId: DecisionId,
  optionId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(DECISION_ANSWER_TEXT_MAX_LENGTH))),
});
export type DecisionsAnswerInput = typeof DecisionsAnswerInput.Type;

/** The user declines to answer; the agent is told so, never that it was approved. */
export const DecisionsDismissInput = Schema.Struct({ decisionId: DecisionId });
export type DecisionsDismissInput = typeof DecisionsDismissInput.Type;

export class DecisionError extends Schema.TaggedError<DecisionError>()("DecisionError", {
  reason: Schema.Literals(["not_found", "not_open", "invalid", "storage"]),
  message: Schema.String,
}) {}
