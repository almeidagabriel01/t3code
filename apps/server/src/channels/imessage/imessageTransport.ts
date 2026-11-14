import {
  ChannelGatewayError,
  type ChannelDeliveryErrorCode,
  type ChannelDeliveryReceipt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { ChannelTransport } from "../ChannelTransport.ts";
import { fingerprintText } from "./imessageAdmission.ts";
import type { ImessageSender } from "./imessageSender.ts";
import { formatImessageMessages } from "./imessageText.ts";

export type ImessageSendReport =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ChannelDeliveryErrorCode };

/**
 * Sends each piece of a reply through Messages. A fingerprint of every piece is stored before it
 * goes out, so its echo in a self chat is not read back as the user's own message. A piece is
 * confirmed once Messages took it or its echo arrived; a retry sends every other piece again.
 */
export function makeImessageTransport(input: {
  readonly connectionId: string;
  readonly sender: ImessageSender;
  readonly sql: SqlClient.SqlClient;
  readonly isActive: Effect.Effect<boolean>;
  readonly report: (result: ImessageSendReport) => Effect.Effect<void>;
}): ChannelTransport {
  const { sql } = input;
  return {
    kind: "imessage",
    send: Effect.fn("ImessageTransport.send")(function* (message) {
      const target = message.destination;
      if (target.kind !== "imessage" || target.connectionId !== input.connectionId) {
        return yield* new ChannelGatewayError({ reason: "invalid_input" });
      }
      if (!(yield* input.isActive)) {
        return yield* new ChannelGatewayError({
          reason: "adapter_unavailable",
          deliveryOutcome: "not_sent",
        });
      }
      const pieces = formatImessageMessages(message);
      for (const [index, text] of pieces.entries()) {
        const pending = yield* sql`
          INSERT INTO imessage_sent (delivery_id, chunk_index, chat_guid, text_hash, sent_at_ms, confirmed)
          VALUES (${message.deliveryId}, ${index}, ${target.chatGuid}, ${fingerprintText(text)},
            ${(yield* DateTime.now).epochMilliseconds}, 0)
          ON CONFLICT (delivery_id, chunk_index) DO UPDATE SET sent_at_ms = excluded.sent_at_ms
          WHERE confirmed = 0 AND consumed = 0
          RETURNING id`.pipe(Effect.orDie);
        if (pending.length === 0) continue;
        const result = yield* Effect.promise(() =>
          input.sender.sendText({ chatGuid: target.chatGuid, text }),
        );
        if ("outcome" in result) {
          // Certainly not sent: its fingerprint must not swallow a real message with the same text.
          if (result.outcome === "not_sent") {
            yield* sql`
              DELETE FROM imessage_sent
              WHERE delivery_id = ${message.deliveryId} AND chunk_index = ${index}`.pipe(
              Effect.orDie,
            );
          }
          yield* input.report({ ok: false, code: result.code });
          return yield* new ChannelGatewayError({
            reason: "delivery_failed",
            deliveryOutcome: result.outcome,
            deliveryErrorCode: result.code,
          });
        }
        yield* sql`
          UPDATE imessage_sent SET confirmed = 1
          WHERE delivery_id = ${message.deliveryId} AND chunk_index = ${index}`.pipe(Effect.orDie);
      }
      yield* input.report({ ok: true });
      return {
        deliveryId: message.deliveryId,
        acceptedAt: DateTime.formatIso(yield* DateTime.now),
      } satisfies ChannelDeliveryReceipt;
    }),
  };
}
