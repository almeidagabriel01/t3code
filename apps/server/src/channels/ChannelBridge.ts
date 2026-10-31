import {
  ChannelGatewayError,
  type ChannelIdentityLinkConsumeInput,
  ChannelInboundMessage,
  type ChannelLinkedIdentity,
  type ChannelNoticeKind,
  ChannelReplyAddress,
  CommandId,
  DecisionId,
  MessageId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
import { ChannelIdentities } from "./ChannelIdentities.ts";
import * as ChannelOutbox from "./ChannelOutbox.ts";

const LINK_CODE_TTL_MINUTES = 10;

const NOTICE_TEXT: Readonly<Record<ChannelNoticeKind, string>> = {
  link_help:
    "To talk to your assistants from Slack, link your account first: in T3 Code open Settings → Slack → Link your account, then send `link <code>` here.",
  link_invalid:
    "That link code did not work. It may have expired or been used already. Create a new one in T3 Code under Settings → Slack → Link your account, then send `link <code>` here.",
};
const LINKED_TEXT =
  "Linked. You can message me here to talk to your assistants; start with @<assistant name> to pick one.";

const AddressJson = Schema.fromJsonString(ChannelReplyAddress);
export const encodeReplyAddress = Schema.encodeSync(AddressJson);
export const decodeReplyAddress = Schema.decodeSync(AddressJson);
const MessageJson = Schema.fromJsonString(ChannelInboundMessage);
const encodeInbound = Schema.encodeSync(MessageJson);
const decodeInbound = Schema.decodeSync(MessageJson);

const persistenceFailed = (cause: unknown) =>
  Effect.logWarning("channel storage failed", { cause }).pipe(
    Effect.andThen(Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" }))),
  );

/**
 * The assistant a message is addressed to: `@<name>` at the start, longest name first so names
 * with spaces win over a shorter prefix, then the text after it. Unknown `@word` is plain text.
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
    readonly identities: ChannelIdentities["Service"];
    /** Sends the messages that were stored but not passed on before the server last stopped. */
    readonly catchUp: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/channels/ChannelBridge") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const hashCode = (connectionId: string, code: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(`${connectionId}:${code}`)).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
      Effect.orDie,
    );
  const outbox = yield* ChannelOutbox.ChannelOutbox;
  const assistants = yield* AssistantService.AssistantService;
  const decisions = yield* DecisionService.DecisionService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const reply = (
    message: Pick<ChannelInboundMessage, "connectionId" | "idempotencyKey" | "replyAddress">,
    suffix: string,
    text: string,
  ) =>
    outbox.enqueue({
      deliveryId: `channel-reply:${message.connectionId}:${message.idempotencyKey}:${suffix}`,
      destination: message.replyAddress,
      text,
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
      yield* reply(message, "failed", `I could not pass that on to ${assistant.name}: ${sent}`);
      yield* markSent(message);
      return;
    }
    yield* sql`
      INSERT OR REPLACE INTO channel_reply_targets (assistant_id, address_json, actor_id)
      VALUES (${assistant.id}, ${encodeReplyAddress(message.replyAddress)}, ${message.actor.externalActorId})`;
    yield* markSent(message);
  });

  const answerChoice = Effect.fn("ChannelBridge.answerChoice")(function* (
    message: ChannelInboundMessage,
  ) {
    const parsed = /^decision:([^:]+):(.+)$/.exec(message.choiceValue ?? "");
    if (parsed === null) return yield* Effect.logInfo("unknown channel button ignored");
    const result = yield* decisions
      .answer({ decisionId: DecisionId.make(parsed[1]!), optionId: parsed[2]! })
      .pipe(Effect.result);
    if (result._tag === "Success") return;
    yield* reply(
      message,
      "choice",
      result.failure.reason === "storage" || result.failure.reason === "invalid"
        ? "I could not record that answer. Please try again."
        : "That decision was already answered.",
    );
  });

  const isolate =
    (what: string) =>
    <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(Effect.catchCause((cause) => Effect.logWarning(what, { cause })));

  const ingest: ChannelGateway["Service"]["ingest"] = Effect.fn("ChannelBridge.ingest")(
    function* (message) {
      const linked = yield* sql`
        SELECT 1 FROM channel_identities
        WHERE connection_id = ${message.connectionId}
          AND external_actor_id = ${message.actor.externalActorId}`.pipe(
        Effect.catch(persistenceFailed),
      );
      if (linked.length === 0) {
        yield* reply(message, "link-help", NOTICE_TEXT.link_help);
        return;
      }
      const isChoice = message.choiceValue !== undefined;
      // A button press is judged once and never replayed, so it is stored as already handled.
      const stored = yield* sql`
        INSERT OR IGNORE INTO channel_inbox (connection_id, idempotency_key, payload_json, state)
        VALUES (${message.connectionId}, ${message.idempotencyKey},
          ${encodeInbound(message)}, ${isChoice ? "sent" : "stored"})
        RETURNING idempotency_key`.pipe(Effect.catch(persistenceFailed));
      if (stored.length === 0) return;
      yield* (isChoice ? answerChoice(message) : deliverMessage(message)).pipe(
        isolate("channel message handling failed"),
      );
    },
    Effect.catchDefect((defect) => persistenceFailed(defect)),
  );

  const consumeCode = Effect.fn("ChannelBridge.consumeCode")(function* (
    input: ChannelIdentityLinkConsumeInput,
  ) {
    const key = yield* sql`
        INSERT OR IGNORE INTO channel_inbox (connection_id, idempotency_key, payload_json, state)
        VALUES (${input.connectionId}, ${input.idempotencyKey}, '{}', 'sent')
        RETURNING idempotency_key`;
    if (key.length === 0) return false;
    const now = yield* nowIso;
    const hash = yield* hashCode(input.connectionId, input.code);
    const used = yield* sql`
        UPDATE channel_link_codes SET used_at = ${now}
        WHERE code_hash = ${hash}
          AND used_at IS NULL AND expires_at > ${now}
        RETURNING code_hash`;
    if (used.length > 0) {
      yield* sql`
          INSERT OR REPLACE INTO channel_identities
            (connection_id, external_actor_id, linked_at)
          VALUES (${input.connectionId}, ${input.externalActorId}, ${now})`;
    }
    yield* outbox.enqueue({
      deliveryId: `channel-link:${input.connectionId}:${input.idempotencyKey}`,
      destination: input.replyAddress,
      text: used.length > 0 ? LINKED_TEXT : NOTICE_TEXT.link_invalid,
    });
    return true;
  });

  const linkIdentity: ChannelGateway["Service"]["linkIdentity"] = Effect.fn(
    "ChannelBridge.linkIdentity",
  )(function* (input) {
    // One transaction: the key, the code and the identity change together, or a redelivery redoes all.
    const changed = yield* sql
      .withTransaction(consumeCode(input))
      .pipe(Effect.catch(persistenceFailed), Effect.catchDefect(persistenceFailed));
    if (changed) yield* outbox.wake;
  });

  const requestNotice: ChannelGateway["Service"]["requestNotice"] = Effect.fn(
    "ChannelBridge.requestNotice",
  )(function* (input) {
    yield* outbox.enqueue({
      deliveryId: `channel-notice:${input.connectionId}:${input.idempotencyKey}`,
      destination: input.replyAddress,
      text: NOTICE_TEXT[input.notice],
    });
  });

  const gateway = ChannelGateway.of({ ingest, linkIdentity, requestNotice });

  const createLinkCode: ChannelIdentities["Service"]["createLinkCode"] = Effect.fn(
    "ChannelIdentities.createLinkCode",
  )(function* (connectionId) {
    const now = yield* DateTime.now;
    const expiresAt = DateTime.formatIso(DateTime.add(now, { minutes: LINK_CODE_TTL_MINUTES }));
    yield* sql`DELETE FROM channel_link_codes WHERE expires_at <= ${DateTime.formatIso(now)}`.pipe(
      Effect.catch(persistenceFailed),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(yield* crypto.randomIntBetween(0, 999_999)).padStart(6, "0");
      const inserted = yield* sql`
        INSERT OR IGNORE INTO channel_link_codes (code_hash, expires_at)
        VALUES (${yield* hashCode(connectionId, code)}, ${expiresAt}) RETURNING code_hash`.pipe(
        Effect.catch(persistenceFailed),
      );
      if (inserted.length > 0) return { code, expiresAt };
    }
    return yield* new ChannelGatewayError({ reason: "persistence_failed" });
  });

  const list: ChannelIdentities["Service"]["list"] = Effect.fn("ChannelIdentities.list")(
    function* (connectionId) {
      const rows = yield* sql<{
        readonly external_actor_id: string;
        readonly display_name: string | null;
        readonly linked_at: string;
      }>`
        SELECT external_actor_id, display_name, linked_at FROM channel_identities
        WHERE connection_id = ${connectionId} ORDER BY linked_at`.pipe(
        Effect.catch(persistenceFailed),
      );
      return rows.map((row): ChannelLinkedIdentity => ({
        connectionId,
        externalActorId: row.external_actor_id,
        ...(row.display_name === null ? {} : { displayName: row.display_name }),
        linkedAt: row.linked_at,
      }));
    },
  );

  const unlink: ChannelIdentities["Service"]["unlink"] = Effect.fn("ChannelIdentities.unlink")(
    function* (input) {
      const removed = yield* sql`
        DELETE FROM channel_identities
        WHERE connection_id = ${input.connectionId}
          AND external_actor_id = ${input.externalActorId}
        RETURNING external_actor_id`.pipe(Effect.catch(persistenceFailed));
      if (removed.length === 0) return yield* new ChannelGatewayError({ reason: "not_found" });
    },
  );

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
    identities: ChannelIdentities.of({ createLinkCode, list, unlink }),
    catchUp,
    start: () => forkParked(catchUp),
  } satisfies ChannelBridge["Service"];
});

const bridgeLayer = Layer.effect(ChannelBridge, make);

/** ChannelGateway, ChannelIdentities and ChannelBridge, all from one instance. */
export const layer = Layer.mergeAll(
  Layer.effect(
    ChannelGateway,
    Effect.map(Effect.service(ChannelBridge), (b) => b.gateway),
  ),
  Layer.effect(
    ChannelIdentities,
    Effect.map(Effect.service(ChannelBridge), (b) => b.identities),
  ),
).pipe(Layer.provideMerge(bridgeLayer));
