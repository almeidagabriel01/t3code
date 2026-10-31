/** Fixtures shared by the bridge, outbox and reply reactor tests. */
import {
  ChannelGatewayError,
  type ChannelDeliveryReceipt,
  ChannelOutboundMessage,
  type ChannelInboundMessage,
  type ChannelOutboundMessage as Outbound,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelTransport from "./ChannelTransport.ts";

export const dmAddress = {
  kind: "imessage",
  connectionId: "c1",
  chatGuid: "iMessage;-;+15550000000",
} as const;
export const otherChatAddress = { ...dmAddress, chatGuid: "iMessage;-;+15550000001" } as const;

let counter = 0;
export const inbound = (overrides: Partial<ChannelInboundMessage> = {}): ChannelInboundMessage => {
  counter += 1;
  return {
    kind: "imessage",
    connectionId: "c1",
    conversationKey: dmAddress.chatGuid,
    externalMessageId: `ext-${counter}`,
    idempotencyKey: `key-${counter}`,
    actor: { externalActorId: "+15550000000" },
    replyAddress: dmAddress,
    text: "hello",
    receivedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
};

export const deliveryError = (
  overrides: Partial<ConstructorParameters<typeof ChannelGatewayError>[0]> = {},
) =>
  new ChannelGatewayError({
    reason: "delivery_failed",
    deliveryOutcome: "not_sent",
    deliveryErrorCode: "unknown",
    ...overrides,
  });

/** A transport that records what it was given; `script` decides each outcome. */
export const fakeTransport = (
  script: (
    message: Outbound,
    call: number,
  ) => Effect.Effect<string | undefined, ChannelGatewayError> = (_message, call) =>
    Effect.succeed(`ts-${call}`),
) => {
  const sent: Outbound[] = [];
  const transport: ChannelTransport.ChannelTransport = {
    kind: "imessage",
    send: (message) =>
      Effect.suspend(() => {
        sent.push(message);
        return script(message, sent.length);
      }).pipe(
        Effect.map((externalMessageId): ChannelDeliveryReceipt => ({
          deliveryId: message.deliveryId,
          acceptedAt: "2026-01-01T00:00:00.000Z",
          ...(externalMessageId === undefined ? {} : { externalMessageId }),
        })),
      ),
  };
  return { sent, transport };
};

const decodeOutbound = Schema.decodeSync(Schema.fromJsonString(ChannelOutboundMessage));

/** Every outbox row, oldest first. */
export const outboxRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly delivery_id: string;
    readonly message_json: string;
    readonly state: string;
    readonly attempts: number;
    readonly external_message_id: string | null;
    readonly last_error_code: string | null;
    readonly replaces_delivery_id: string | null;
  }>`SELECT * FROM channel_outbox ORDER BY rowid`;
  return rows.map((row) => ({ ...row, message: decodeOutbound(row.message_json) }));
});
