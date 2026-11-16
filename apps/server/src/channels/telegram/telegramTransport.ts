import {
  ChannelGatewayError,
  type ChannelDeliveryErrorCode,
  type ChannelDeliveryReceipt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { ChannelTransport } from "../ChannelTransport.ts";
import type { TelegramApi, TelegramApiError } from "./telegramApi.ts";
import { formatTelegramMessages } from "./telegramText.ts";

export type TelegramSendReport =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ChannelDeliveryErrorCode; readonly invalidToken: boolean };

const deliveryCode = (error: TelegramApiError): ChannelDeliveryErrorCode =>
  error.code === "chat_not_found" || error.code === "bad_request"
    ? "chat_not_found"
    : error.code === "timeout"
      ? "timeout"
      : "unknown";

/**
 * Sends each piece of a reply as its own message. A piece is recorded as confirmed once Telegram
 * answers for it, so a retry repeats none of those; a piece Telegram refused or never answered for
 * goes again, because a possible duplicate beats a lost reply.
 */
export function makeTelegramTransport(input: {
  readonly connectionId: string;
  /** The client for the running configuration; undefined while the channel is off. */
  readonly api: Effect.Effect<TelegramApi | undefined>;
  readonly sql: SqlClient.SqlClient;
  /** Origin of the web links thread links become. */
  readonly hostedAppUrl: string;
  readonly report: (result: TelegramSendReport) => Effect.Effect<void>;
}): ChannelTransport {
  const { sql } = input;
  return {
    kind: "telegram",
    send: Effect.fn("TelegramTransport.send")(function* (message) {
      const target = message.destination;
      if (target.kind !== "telegram" || target.connectionId !== input.connectionId) {
        return yield* new ChannelGatewayError({ reason: "invalid_input" });
      }
      const api = yield* input.api;
      if (api === undefined) {
        return yield* new ChannelGatewayError({
          reason: "adapter_unavailable",
          deliveryOutcome: "not_sent",
        });
      }
      let lastId: string | undefined;
      for (const [index, text] of formatTelegramMessages(message, {
        hostedAppUrl: input.hostedAppUrl,
      }).entries()) {
        const pending = yield* sql`
          INSERT INTO telegram_sent (delivery_id, chunk_index, sent_at_ms, confirmed)
          VALUES (${message.deliveryId}, ${index}, ${(yield* DateTime.now).epochMilliseconds}, 0)
          ON CONFLICT (delivery_id, chunk_index) DO UPDATE SET sent_at_ms = excluded.sent_at_ms
          WHERE confirmed = 0
          RETURNING chunk_index`.pipe(Effect.orDie);
        if (pending.length === 0) continue;
        const sent = yield* Effect.result(api.sendMessage({ chatId: target.chatId, text }));
        if (sent._tag === "Failure") {
          const error = sent.failure;
          yield* input.report({
            ok: false,
            code: deliveryCode(error),
            invalidToken: error.code === "invalid_token",
          });
          return yield* new ChannelGatewayError({
            reason: "delivery_failed",
            deliveryOutcome: error.outcome,
            deliveryErrorCode: deliveryCode(error),
            ...(error.retryAfterSeconds !== undefined && error.retryAfterSeconds >= 1
              ? { retryAfterSeconds: Math.ceil(error.retryAfterSeconds) }
              : {}),
          });
        }
        yield* sql`
          UPDATE telegram_sent SET confirmed = 1
          WHERE delivery_id = ${message.deliveryId} AND chunk_index = ${index}`.pipe(Effect.orDie);
        lastId = sent.success.messageId === "" ? lastId : sent.success.messageId;
      }
      yield* input.report({ ok: true });
      return {
        deliveryId: message.deliveryId,
        acceptedAt: DateTime.formatIso(yield* DateTime.now),
        ...(lastId === undefined ? {} : { externalMessageId: lastId }),
      } satisfies ChannelDeliveryReceipt;
    }),
  };
}
