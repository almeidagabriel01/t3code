// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hash.
import * as NodeCrypto from "node:crypto";

import { DECISION_CONTEXT_MAX_LENGTH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DecisionService } from "../decisions/DecisionService.ts";
import {
  APPROVAL_UNAVAILABLE,
  AskBeforeActingGate,
  SEND_DECLINED,
  WAITING_FOR_APPROVAL,
  type SendApproval,
  type SendApprovalInput,
} from "./AskBeforeActingGate.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

/** One decision per (assistant, target, exact text) attempt; `:n` starts a fresh ask once one is used. */
const requestKey = (input: SendApprovalInput, attempt: number) =>
  `ask-before-acting:${NodeCrypto.createHash("sha256")
    .update(`${input.assistant.id}\0${input.targetThreadId}\0${input.text}`)
    .digest("hex")}:${attempt}`;

const clip = (text: string, max: number) => Array.from(text).slice(0, max).join("");

export const installLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gate = yield* AskBeforeActingGate;
    const decisions = yield* DecisionService;
    const threads = yield* ThreadManagementService;
    // ponytail: walks every earlier attempt of the same text; cheap until one text is sent thousands of times.
    const check = Effect.fn("AskBeforeActing.check")(function* (input: SendApprovalInput) {
      const targetTitle = yield* threads.getThreadRecords(input.targetThreadId, []).pipe(
        Effect.map((records) => records.thread.title),
        Effect.orElseSucceed(() => "another conversation"),
      );
      for (let attempt = 0; ; attempt++) {
        const decision = yield* decisions.request({
          fromThreadId: input.senderThreadId,
          projectId: input.assistant.projectId,
          threadTitle: input.assistant.name,
          clientRequestId: requestKey(input, attempt),
          title: clip(`${input.assistant.name} wants to send a message to ${targetTitle}`, 120),
          context: clip(input.text, DECISION_CONTEXT_MAX_LENGTH),
          options: [
            { id: "accept", label: "Approve", consequence: "The message is sent once" },
            { id: "deny", label: "Deny", consequence: "Nothing is sent" },
          ],
          recommended: "deny",
          expiresInMinutes: 60 * 24,
        });
        if (decision.status === "open") {
          return { allowed: false, message: WAITING_FOR_APPROVAL } satisfies SendApproval;
        }
        if (decision.status !== "answered") continue;
        // Answered decisions are used up by the first send that sees them, approved or not.
        const claimed = yield* decisions.claimExecution(decision.id);
        if (!claimed) continue;
        return decision.answer?.optionId === "accept"
          ? ({
              allowed: true,
              release: decisions.releaseExecution(decision.id).pipe(Effect.ignore),
            } satisfies SendApproval)
          : ({ allowed: false, message: SEND_DECLINED } satisfies SendApproval);
      }
    });
    yield* gate.install((input) =>
      check(input).pipe(
        Effect.orElseSucceed((): SendApproval => ({
          allowed: false,
          message: APPROVAL_UNAVAILABLE,
        })),
      ),
    );
  }),
);
