import { DecisionError, type DecisionsAnswerInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AttachmentClaims from "../orchestration-v2/AttachmentClaims.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DecisionService from "./DecisionService.ts";

/**
 * Answers a decision with uploaded files: they are claimed to the requesting thread first, so the
 * agent's message can carry them, and released again when the answer is not stored.
 */
export const answerDecision = Effect.fn("DecisionAttachmentIntake.answerDecision")(function* (
  input: DecisionsAnswerInput,
) {
  const decisions = yield* DecisionService.DecisionService;
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return yield* decisions.answer(input);
  const decision = yield* decisions.get(input.decisionId);
  if (decision.approvalRequestId !== undefined) {
    return yield* new DecisionError({
      reason: "invalid",
      message: "This decision mirrors an approval and cannot take attachments.",
    });
  }
  // Only fresh uploads: naming a file the thread already holds would let a failed answer delete it.
  if (!attachments.every(AttachmentClaims.attachmentIsPendingUpload)) {
    return yield* new DecisionError({
      reason: "invalid",
      message: "Attachments must be fresh uploads.",
    });
  }
  // Files claimed to an archived or deleted thread could never be delivered and would stay on disk.
  const threadIsGone = yield* ThreadManagement.ThreadManagementService.pipe(
    Effect.flatMap((threads) => threads.getThreadRecords(decision.fromThreadId, [])),
    Effect.map(({ thread }) => thread.deletedAt !== null || thread.archivedAt !== null),
    Effect.orElseSucceed(() => true),
  );
  if (threadIsGone) {
    return yield* new DecisionError({
      reason: "invalid",
      message: "The thread that asked was archived or deleted, so it cannot receive files.",
    });
  }
  yield* AttachmentClaims.validateAttachmentLimits(attachments).pipe(
    Effect.mapError((error) => new DecisionError({ reason: "invalid", message: error.message })),
  );
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: decision.fromThreadId,
    attachments,
  }).pipe(
    Effect.mapError((error) => new DecisionError({ reason: "invalid", message: error.message })),
  );
  return yield* decisions
    .answer({
      ...input,
      attachments: claimed.attachments as NonNullable<DecisionsAnswerInput["attachments"]>,
    })
    .pipe(Effect.tapError(() => AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)));
});
