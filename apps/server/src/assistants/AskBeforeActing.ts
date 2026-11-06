// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hash.
import * as NodeCrypto from "node:crypto";

import { DECISION_CONTEXT_MAX_LENGTH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DECISION_PHRASES } from "../channels/channelStrings.ts";
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
          title: clip(
            `${input.assistant.name} ${DECISION_PHRASES.wantsToSend} ${targetTitle}`,
            120,
          ),
          // The card clips the title, so the body names where the message goes.
          context: clip(
            `${DECISION_PHRASES.to} ${targetTitle}\n\n${input.text}`,
            DECISION_CONTEXT_MAX_LENGTH,
          ),
          options: [
            {
              id: "accept",
              label: DECISION_PHRASES.approve,
              consequence: "The message is sent once",
            },
            { id: "deny", label: DECISION_PHRASES.deny, consequence: "Nothing is sent" },
          ],
          recommended: "deny",
          expiresInMinutes: 60 * 24,
        });
        if (decision.status === "open") {
          return { allowed: false, message: WAITING_FOR_APPROVAL } satisfies SendApproval;
        }
        // An unanswered ask that timed out is stale, not a refusal: ask again.
        if (decision.status === "expired") continue;
        // A denial or a dismissal stays refused for this exact text; the user said no.
        if (decision.status !== "answered" || decision.answer?.optionId !== "accept") {
          return { allowed: false, message: SEND_DECLINED } satisfies SendApproval;
        }
        // One send per approval: the first send to claim it uses it, later ones ask again.
        if (!(yield* decisions.claimExecution(decision.id))) continue;
        return {
          allowed: true,
          release: decisions.releaseExecution(decision.id).pipe(Effect.ignore),
        } satisfies SendApproval;
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
