// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hash.
import * as NodeCrypto from "node:crypto";

import { DECISION_CONTEXT_MAX_LENGTH, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DECISION_PHRASES } from "../channels/channelStrings.ts";
import { DecisionService } from "../decisions/DecisionService.ts";
import {
  APPROVAL_UNAVAILABLE,
  AskBeforeActingGate,
  SEND_DECLINED,
  TOOL_APPROVAL_UNAVAILABLE,
  TOOL_DECLINED,
  TOOL_WAITING_FOR_APPROVAL,
  WAITING_FOR_APPROVAL,
  type SendApproval,
  type SendApprovalInput,
  type ToolApprovalInput,
} from "./AskBeforeActingGate.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

/** An approved tool call must be repeated within this window, or the next call asks again. */
const TOOL_APPROVAL_WINDOW_MS = 10 * 60 * 1000;

const hash = (...parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex");

const clip = (text: string, max: number) => Array.from(text).slice(0, max).join("");

interface Ask {
  readonly fromThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadTitle: string;
  /** One decision per attempt of the same action; `:n` starts a fresh ask once one is used. */
  readonly key: string;
  readonly title: string;
  readonly context: string;
  readonly acceptConsequence: string;
  readonly waiting: string;
  readonly declined: string;
  /** An approval older than this asks again instead of allowing. */
  readonly approvalWindowMs?: number;
}

export const installLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gate = yield* AskBeforeActingGate;
    const decisions = yield* DecisionService;
    const threads = yield* ThreadManagementService;
    // ponytail: walks every earlier attempt of the same action; cheap until one is repeated thousands of times.
    const askOnce = Effect.fn("AskBeforeActing.askOnce")(function* (ask: Ask) {
      for (let attempt = 0; ; attempt++) {
        const decision = yield* decisions.request({
          fromThreadId: ask.fromThreadId,
          projectId: ask.projectId,
          threadTitle: ask.threadTitle,
          clientRequestId: `${ask.key}:${attempt}`,
          title: clip(ask.title, 120),
          context: clip(ask.context, DECISION_CONTEXT_MAX_LENGTH),
          options: [
            { id: "accept", label: DECISION_PHRASES.approve, consequence: ask.acceptConsequence },
            { id: "deny", label: DECISION_PHRASES.deny, consequence: "Nothing is sent" },
          ],
          recommended: "deny",
          expiresInMinutes: 60 * 24,
        });
        if (decision.status === "open") {
          return { allowed: false, message: ask.waiting } satisfies SendApproval;
        }
        // An unanswered ask that timed out is stale, not a refusal: ask again.
        if (decision.status === "expired") continue;
        // A denial or a dismissal stays refused for this exact action; the user said no.
        if (decision.status !== "answered" || decision.answer?.optionId !== "accept") {
          return { allowed: false, message: ask.declined } satisfies SendApproval;
        }
        if (ask.approvalWindowMs !== undefined && decision.answeredAt !== undefined) {
          const answeredAt = DateTime.toEpochMillis(DateTime.makeUnsafe(decision.answeredAt));
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (now - answeredAt > ask.approvalWindowMs) continue;
        }
        // One action per approval: the first to claim it uses it, later ones ask again.
        if (!(yield* decisions.claimExecution(decision.id))) continue;
        return {
          allowed: true,
          release: decisions.releaseExecution(decision.id).pipe(Effect.ignore),
        } satisfies SendApproval;
      }
    });

    const checkSend = Effect.fn("AskBeforeActing.check")(function* (input: SendApprovalInput) {
      const targetTitle = yield* threads.getThreadRecords(input.targetThreadId, []).pipe(
        Effect.map((records) => records.thread.title),
        Effect.orElseSucceed(() => "another conversation"),
      );
      return yield* askOnce({
        fromThreadId: input.senderThreadId,
        projectId: input.assistant.projectId,
        threadTitle: input.assistant.name,
        key: `ask-before-acting:${hash(input.assistant.id, input.targetThreadId, input.text)}`,
        title: `${input.assistant.name} ${DECISION_PHRASES.wantsToSend} ${targetTitle}`,
        // The card clips the title, so the body names where the message goes.
        context: `${DECISION_PHRASES.to} ${targetTitle}\n\n${input.text}`,
        acceptConsequence: "The message is sent once",
        waiting: WAITING_FOR_APPROVAL,
        declined: SEND_DECLINED,
      });
    });

    const checkTool = (input: ToolApprovalInput) =>
      askOnce({
        fromThreadId: input.threadId,
        projectId: input.assistant.projectId,
        threadTitle: input.assistant.name,
        key: `ask-before-acting-tool:${hash(input.assistant.id, input.integration, input.tool, input.argsHash)}`,
        title: `${input.assistant.name} ${DECISION_PHRASES.wantsToUse} ${input.serviceName}: ${input.tool}`,
        context: `${input.serviceName} · ${input.tool}\n\n${input.argsPreview}`,
        acceptConsequence: "The action runs once",
        waiting: TOOL_WAITING_FOR_APPROVAL,
        declined: TOOL_DECLINED,
        approvalWindowMs: TOOL_APPROVAL_WINDOW_MS,
      });

    yield* gate.install((input) =>
      checkSend(input).pipe(
        Effect.orElseSucceed((): SendApproval => ({
          allowed: false,
          message: APPROVAL_UNAVAILABLE,
        })),
      ),
    );
    yield* gate.installToolApproval((input) =>
      checkTool(input).pipe(
        Effect.orElseSucceed((): SendApproval => ({
          allowed: false,
          message: TOOL_APPROVAL_UNAVAILABLE,
        })),
      ),
    );
  }),
);
