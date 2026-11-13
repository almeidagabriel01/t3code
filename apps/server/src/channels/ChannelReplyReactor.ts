import {
  assistantIdFromThreadId,
  ChannelOutboundMessage,
  type ChannelReplyAddress,
  type Decision,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as DecisionService from "../decisions/DecisionService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { decodeReplyAddress } from "./ChannelBridge.ts";
import { redactChannelText } from "./channelRedaction.ts";
import { ChannelLanguage } from "./ChannelLanguage.ts";
import * as ChannelOutbox from "./ChannelOutbox.ts";
import {
  channelStrings,
  localizeDecision,
  type ResolvedChannelLanguage,
} from "./channelStrings.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const decodeStoredMessage = Schema.decodeSync(Schema.fromJsonString(ChannelOutboundMessage));

/** What the card says once nobody can press it any more. */
export function settledLine(decision: Decision, language: ResolvedChannelLanguage = "en"): string {
  const t = channelStrings(language);
  switch (decision.status) {
    case "withdrawn":
      return t.withdrawn;
    case "expired":
      return t.expired;
    default: {
      const optionId = decision.answer?.optionId;
      if (decision.approvalRequestId !== undefined && optionId === "accept") return t.approved;
      if (decision.approvalRequestId !== undefined && optionId === "decline") return t.denied;
      const chosen =
        localizeDecision(decision, language).options.find((option) => option.id === optionId)
          ?.label ?? decision.answer?.text;
      return chosen === undefined ? t.dismissed : t.answered(chosen);
    }
  }
}

export class ChannelReplyReactor extends Context.Service<
  ChannelReplyReactor,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly handleDecision: (decision: Decision) => Effect.Effect<void>;
    /** Follows run and message events and the decision stream until the scope closes. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/channels/ChannelReplyReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const decisions = yield* DecisionService.DecisionService;
  const outbox = yield* ChannelOutbox.ChannelOutbox;
  const channelLanguage = yield* ChannelLanguage;
  const sql = yield* SqlClient.SqlClient;

  const targetFor = Effect.fn("ChannelReplyReactor.targetFor")(function* (threadId: string) {
    const assistantId = assistantIdFromThreadId(threadId);
    if (assistantId === null) return undefined;
    const rows = yield* sql<{ readonly address_json: string; readonly name: string | null }>`
      SELECT t.address_json, a.name FROM channel_reply_targets t
      LEFT JOIN assistants a ON a.assistant_id = t.assistant_id
      WHERE t.assistant_id = ${assistantId}`;
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          address: decodeReplyAddress(row.address_json) as ChannelReplyAddress,
          assistantName: row.name ?? "Assistant",
        };
  });

  const postRun = Effect.fn("ChannelReplyReactor.postRun")(function* (
    run: Extract<OrchestrationV2DomainEvent, { type: "run.updated" }>["payload"],
  ) {
    const target = yield* targetFor(run.threadId);
    const deliveryId = `channel-run:${run.id}`;
    if (target === undefined || Option.isSome(yield* outbox.find(deliveryId))) return;
    const records = yield* threads.getThreadRecords(run.threadId, ["messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [run.id],
      turnItemRunIds: [run.id],
      turnItemTypes: ["error"],
    });
    const answer = records.messages.findLast((message) => message.text.trim() !== "")?.text;
    const failure = records.turnItems.findLast((item) => item.type === "error");
    const language = yield* channelLanguage.current;
    const text =
      answer ??
      (run.status !== "failed"
        ? undefined
        : channelStrings(language).couldNotFinish(
            failure?.type === "error" ? failure.failure.message : undefined,
          ));
    if (text === undefined) return;
    yield* outbox.enqueue({
      deliveryId,
      destination: target.address,
      senderName: target.assistantName,
      text,
      language,
    });
  });

  const handle: ChannelReplyReactor["Service"]["handle"] = (event) => {
    const work =
      event.type === "run.updated" && TERMINAL.has(event.payload.status)
        ? postRun(event.payload)
        : event.type === "message.updated" &&
            event.payload.role === "user" &&
            event.payload.createdBy === "user" &&
            (event.payload.creationSource === "web" || event.payload.creationSource === "mobile")
          ? // The conversation moved to the app: replies stop going to the chat.
            Effect.gen(function* () {
              const assistantId = assistantIdFromThreadId(event.payload.threadId);
              if (assistantId !== null) {
                yield* sql`DELETE FROM channel_reply_targets WHERE assistant_id = ${assistantId}`;
              }
            })
          : Effect.void;
    return work.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("sending a channel reply failed", { eventType: event.type, cause }),
      ),
    );
  };

  const handleDecision: ChannelReplyReactor["Service"]["handleDecision"] = Effect.fn(
    "ChannelReplyReactor.handleDecision",
  )(
    function* (decision) {
      const deliveryId = `channel-decision:${decision.id}`;
      if (decision.status === "open") {
        const target = yield* targetFor(decision.fromThreadId);
        if (target === undefined) return;
        const card = yield* sql`SELECT 1 FROM channel_cards WHERE decision_id = ${decision.id}`;
        if (card.length > 0) return;
        const language = yield* channelLanguage.current;
        const shown = localizeDecision(decision, language);
        yield* outbox.enqueue({
          deliveryId,
          destination: target.address,
          senderName: target.assistantName,
          text: redactChannelText(
            [shown.title, shown.context].filter((part) => part !== "").join("\n\n"),
          ),
          choices: shown.options.map((option) => ({
            label: option.label,
            value: option.id,
          })),
          language,
        });
        yield* sql`INSERT OR IGNORE INTO channel_cards (decision_id, delivery_id) VALUES (${decision.id}, ${deliveryId})`;
        return;
      }
      const card = yield* sql<{ readonly delivery_id: string }>`
        SELECT delivery_id FROM channel_cards WHERE decision_id = ${decision.id}`;
      if (card[0] === undefined) return;
      const original = Option.getOrUndefined(yield* outbox.find(card[0].delivery_id));
      if (original === undefined) return;
      const { destination, senderName } = decodeStoredMessage(original.message_json);
      const language = yield* channelLanguage.current;
      yield* outbox.enqueue({
        deliveryId: `channel-decision-settled:${decision.id}`,
        destination,
        senderName,
        // The settled line reads "<title> — <outcome>"; chat has no other place to put the title.
        // oxlint-disable-next-line t3code/no-em-dash-copy -- fixed product format
        text: `${localizeDecision(decision, language).title} — ${settledLine(decision, language)}`,
        language,
      });
    },
    (effect, decision) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("mirroring a decision to a channel failed", {
            decisionId: decision.id,
            cause,
          }),
        ),
      ),
  );

  const start: ChannelReplyReactor["Service"]["start"] = () =>
    forkParked(
      Effect.all(
        [
          Stream.runForEach(engine.streamDomainEvents, handle),
          // The first event is the snapshot, which doubles as catch-up for what changed while stopped.
          Stream.runForEach(decisions.subscribe, (event) =>
            event.type === "snapshot"
              ? Effect.forEach(event.decisions, handleDecision, { discard: true })
              : handleDecision(event.decision),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.catchCause((cause) => Effect.logWarning("channel reply stream failed", { cause })),
      ),
    );

  return { handle, handleDecision, start } satisfies ChannelReplyReactor["Service"];
});

export const layer = Layer.effect(ChannelReplyReactor, make);
