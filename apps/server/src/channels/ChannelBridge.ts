import {
  channelChatKey,
  ChannelGatewayError,
  ChannelInboundMessage,
  ChannelReplyAddress,
  CommandId,
  DecisionId,
  MessageId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as AssistantService from "../assistants/AssistantService.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { ChannelGateway } from "./ChannelGateway.ts";
import * as ChannelOutbox from "./ChannelOutbox.ts";

const AddressJson = Schema.fromJsonString(ChannelReplyAddress);
export const encodeReplyAddress = Schema.encodeSync(AddressJson);
export const decodeReplyAddress = Schema.decodeSync(AddressJson);
const MessageJson = Schema.fromJsonString(ChannelInboundMessage);
const encodeInbound = Schema.encodeSync(MessageJson);
const decodeInbound = Schema.decodeSync(MessageJson);

/** A reply that is only a number, such as `2`, `2.` or ` 2) `, answers an open card. */
export function parseNumberReply(text: string): number | undefined {
  const match = /^\s*(\d{1,2})\s*[.)]?\s*$/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

const SYSTEM_SENDER = "T3 Code";
/** Guards against reply loops and floods; counted from each message's own receive time. */
export const INBOUND_PER_MINUTE = 10;

const persistenceFailed = (cause: unknown) =>
  Effect.logWarning("channel storage failed", { cause }).pipe(
    Effect.andThen(Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" }))),
  );

/**
 * The assistant a message is addressed to: `@<name>` at the start, longest name first so names
 * with spaces win over a shorter prefix, then the text after it.
 */
function routeByName<A extends { readonly name: string }>(
  text: string,
  assistants: ReadonlyArray<A>,
): { readonly assistant: A; readonly text: string } | undefined {
  const lowered = text.trimStart().toLowerCase();
  for (const assistant of assistants.toSorted((a, b) => b.name.length - a.name.length)) {
    const prefix = `@${assistant.name.toLowerCase()}`;
    const next = lowered.charAt(prefix.length);
    if (lowered.startsWith(prefix) && (next === "" || /\s/.test(next))) {
      return { assistant, text: text.trimStart().slice(prefix.length).trim() };
    }
  }
  return undefined;
}

export class ChannelBridge extends Context.Service<
  ChannelBridge,
  {
    readonly gateway: ChannelGateway["Service"];
    /** Sends the messages that were stored but not passed on before the server last stopped. */
    readonly catchUp: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/channels/ChannelBridge") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const outbox = yield* ChannelOutbox.ChannelOutbox;
  const assistants = yield* AssistantService.AssistantService;
  const decisions = yield* DecisionService.DecisionService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const reply = (
    message: Pick<ChannelInboundMessage, "connectionId" | "idempotencyKey" | "replyAddress">,
    suffix: string,
    text: string,
    senderName = SYSTEM_SENDER,
  ) =>
    outbox.enqueue({
      deliveryId: `channel-reply:${message.connectionId}:${message.idempotencyKey}:${suffix}`,
      destination: message.replyAddress,
      text,
      senderName,
    });

  const markSent = (message: ChannelInboundMessage) =>
    sql`
      UPDATE channel_inbox SET state = 'sent'
      WHERE connection_id = ${message.connectionId} AND idempotency_key = ${message.idempotencyKey}`;

  const pickAssistant = Effect.fn("ChannelBridge.pickAssistant")(function* (
    message: ChannelInboundMessage,
  ) {
    const active = (yield* assistants.list).filter((assistant) => assistant.archivedAt === null);
    const named = routeByName(message.text, active);
    if (named !== undefined) {
      yield* sql`
        INSERT OR REPLACE INTO channel_conversations (connection_id, conversation_key, assistant_id)
        VALUES (${message.connectionId}, ${message.conversationKey}, ${named.assistant.id})`;
      return { assistant: named.assistant, text: named.text };
    }
    // `@` alone or an unknown `@name` asks who is there; the chat has no other way to find out.
    if (message.text.trimStart().startsWith("@")) {
      const listed = active.length > 0 ? active : [yield* assistants.ensureDefault];
      return { roster: listed.toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault)) };
    }
    const sticky = yield* sql<{ readonly assistant_id: string }>`
      SELECT assistant_id FROM channel_conversations
      WHERE connection_id = ${message.connectionId} AND conversation_key = ${message.conversationKey}`;
    const assistant =
      active.find((candidate) => candidate.id === sticky[0]?.assistant_id) ??
      active.find((candidate) => candidate.isDefault) ??
      (yield* assistants.ensureDefault);
    return { assistant, text: message.text };
  });

  /** Routes one stored message to an assistant's thread. Every outcome ends in `sent` or a reply. */
  const deliverMessage = Effect.fn("ChannelBridge.deliverMessage")(function* (
    message: ChannelInboundMessage,
  ) {
    const number = parseNumberReply(message.text);
    if (number !== undefined && (yield* answerByNumber(message, number))) {
      yield* markSent(message);
      return;
    }
    const picked = yield* Effect.result(pickAssistant(message));
    if (picked._tag === "Failure") {
      yield* reply(
        message,
        "failed",
        "I could not reach your assistants right now. Please try again.",
      );
      yield* markSent(message);
      return;
    }
    if ("roster" in picked.success) {
      const [first] = picked.success.roster;
      yield* reply(
        message,
        "roster",
        `Your assistants: ${picked.success.roster.map((entry) => entry.name).join(", ")}. Start a message with @Name to talk to one${first?.isDefault ? `; ${first.name} answers otherwise` : ""}.`,
      );
      yield* markSent(message);
      return;
    }
    const { assistant, text } = picked.success;
    if (text === "") {
      yield* reply(message, "switched", `You are now talking to ${assistant.name}.`);
      yield* markSent(message);
      return;
    }
    const id = `channel:${message.connectionId}:${message.idempotencyKey}`;
    const sent =
      assistant.threadId === null
        ? "its conversation has not started yet"
        : yield* threads
            .sendToThread({
              projectId: assistant.projectId,
              commandId: CommandId.make(id),
              messageId: MessageId.make(id),
              threadId: assistant.threadId,
              text,
              attachments: [],
              mode: "queue",
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(
              Effect.as(undefined),
              Effect.catch((failure) =>
                Effect.logWarning("channel message was not delivered", { failure }).pipe(
                  Effect.as(String(failure.message ?? failure._tag).slice(0, 200)),
                ),
              ),
            );
    if (sent !== undefined) {
      yield* reply(message, "failed", `I could not pass that on: ${sent}`, assistant.name);
      yield* markSent(message);
      return;
    }
    yield* sql`
      INSERT OR REPLACE INTO channel_reply_targets (assistant_id, address_json, actor_id)
      VALUES (${assistant.id}, ${encodeReplyAddress(message.replyAddress)}, ${message.actor.externalActorId})`;
    yield* markSent(message);
  });

  /** The newest card sent to this chat that nobody has answered yet. */
  const openCardFor = Effect.fn("ChannelBridge.openCardFor")(function* (
    message: ChannelInboundMessage,
  ) {
    const cards = yield* sql<{ readonly decision_id: string }>`
      SELECT c.decision_id FROM channel_cards c
      JOIN channel_outbox o ON o.delivery_id = c.delivery_id
      WHERE json_extract(o.message_json, '$.destination.connectionId') = ${message.connectionId}
        AND json_extract(o.message_json, '$.destination.kind') = ${message.replyAddress.kind}
        AND COALESCE(json_extract(o.message_json, '$.destination.chatGuid'),
          json_extract(o.message_json, '$.destination.chatId')) = ${channelChatKey(message.replyAddress)}
      ORDER BY o.rowid DESC LIMIT 20`;
    for (const card of cards) {
      const decision = yield* decisions.get(DecisionId.make(card.decision_id)).pipe(Effect.result);
      if (decision._tag === "Success" && decision.success.status === "open") {
        return decision.success;
      }
    }
    return undefined;
  });

  /** Answers the open card with option `number`; false when no card is open, so it is a normal message. */
  const answerByNumber = Effect.fn("ChannelBridge.answerByNumber")(function* (
    message: ChannelInboundMessage,
    number: number,
  ) {
    const card = yield* openCardFor(message);
    if (card === undefined) return false;
    const option = card.options[number - 1];
    if (option === undefined) {
      yield* reply(message, "choice", `Reply with a number from 1 to ${card.options.length}.`);
      return true;
    }
    const result = yield* decisions
      .answer({ decisionId: card.id, optionId: option.id })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* reply(
        message,
        "choice",
        result.failure.reason === "storage" || result.failure.reason === "invalid"
          ? "I could not record that answer. Please try again."
          : "That decision was already answered.",
      );
    }
    return true;
  });

  const isolate =
    (what: string) =>
    <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(Effect.catchCause((cause) => Effect.logWarning(what, { cause })));

  const ingest: ChannelGateway["Service"]["ingest"] = Effect.fn("ChannelBridge.ingest")(
    function* (message) {
      const stored = yield* sql`
        INSERT OR IGNORE INTO channel_inbox (connection_id, idempotency_key, payload_json, state)
        VALUES (${message.connectionId}, ${message.idempotencyKey},
          ${encodeInbound(message)}, 'stored')
        RETURNING idempotency_key`.pipe(Effect.catch(persistenceFailed));
      if (stored.length === 0) return;
      const since = DateTime.formatIso(
        DateTime.subtract(DateTime.makeUnsafe(message.receivedAt), { minutes: 1 }),
      );
      // ponytail: scans the sender's inbox rows; add a received_at column if the inbox grows large.
      const [recent] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM channel_inbox
        WHERE connection_id = ${message.connectionId}
          AND json_extract(payload_json, '$.actor.externalActorId') = ${message.actor.externalActorId}
          AND json_extract(payload_json, '$.receivedAt') > ${since}
          AND json_extract(payload_json, '$.receivedAt') <= ${message.receivedAt}`.pipe(
        Effect.catch(persistenceFailed),
      );
      if ((recent?.count ?? 0) > INBOUND_PER_MINUTE) {
        yield* sql`
          UPDATE channel_inbox SET state = 'limited'
          WHERE connection_id = ${message.connectionId}
            AND idempotency_key = ${message.idempotencyKey}`.pipe(Effect.catch(persistenceFailed));
        if (recent?.count === INBOUND_PER_MINUTE + 1) {
          yield* reply(
            message,
            "limited",
            "You're sending messages too fast. I'll read new ones again in a minute.",
          ).pipe(isolate("sending the rate limit notice failed"));
        }
        return;
      }
      yield* deliverMessage(message).pipe(isolate("channel message handling failed"));
    },
    Effect.catchDefect((defect) => persistenceFailed(defect)),
  );

  const gateway = ChannelGateway.of({ ingest });

  const catchUp: ChannelBridge["Service"]["catchUp"] = Effect.gen(function* () {
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM channel_inbox WHERE state = 'stored' ORDER BY rowid`;
    yield* Effect.forEach(
      rows,
      (row) =>
        deliverMessage(decodeInbound(row.payload_json)).pipe(
          isolate("catching up a channel message failed"),
        ),
      { discard: true },
    );
  }).pipe(isolate("catching up channel messages failed"));

  return {
    gateway,
    catchUp,
    start: () => forkParked(catchUp),
  } satisfies ChannelBridge["Service"];
});

/** ChannelGateway and ChannelBridge, both from one instance. */
export const layer = Layer.effect(
  ChannelGateway,
  Effect.map(Effect.service(ChannelBridge), (b) => b.gateway),
).pipe(Layer.provideMerge(Layer.effect(ChannelBridge, make)));
