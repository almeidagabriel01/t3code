/**
 * The three Bot API calls the channel needs, over Effect's HttpClient. The token is part of the
 * request URL, so no error here carries a request, a URL or a response body: only a fixed code.
 */
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { TelegramText } from "./telegramText.ts";

const API_ORIGIN = "https://api.telegram.org";
/** The long poll waits this long for an update; the request is only given up on well after it. */
export const LONG_POLL_SECONDS = 25;
const REQUEST_GRACE_SECONDS = 15;

export const TelegramApiErrorCode = Schema.Literals([
  "invalid_token",
  "conflict",
  "rate_limited",
  "chat_not_found",
  /** 400: Telegram refused this request as written, for example HTML it could not parse. */
  "bad_request",
  "unreachable",
  "timeout",
]);
export type TelegramApiErrorCode = typeof TelegramApiErrorCode.Type;

export class TelegramApiError extends Schema.TaggedError<TelegramApiError>()("TelegramApiError", {
  code: TelegramApiErrorCode,
  /** Seconds Telegram asked us to wait. */
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  /** `not_sent` when Telegram answered that it did not take the request; otherwise unknown. */
  outcome: Schema.Literals(["not_sent", "unknown"]),
}) {
  override get message(): string {
    return `Telegram request failed: ${this.code}.`;
  }
}

const Message = Schema.Struct({
  message_id: Schema.Number,
  date: Schema.Number,
  text: Schema.optional(Schema.String),
  chat: Schema.Struct({ id: Schema.Number, type: Schema.String }),
  from: Schema.optional(
    Schema.Struct({
      id: Schema.Number,
      is_bot: Schema.optional(Schema.Boolean),
      first_name: Schema.optional(Schema.String),
      username: Schema.optional(Schema.String),
    }),
  ),
});
export type TelegramMessage = typeof Message.Type;

export interface TelegramUpdate {
  readonly updateId: number;
  /** Undefined for updates that are not a readable message; they are still acknowledged. */
  readonly message: TelegramMessage | undefined;
}

const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error_code: Schema.optional(Schema.Number),
  parameters: Schema.optional(Schema.Struct({ retry_after: Schema.optional(Schema.Number) })),
});
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope));
const decodeMessage = Schema.decodeUnknownOption(Message);
const decodeUpdateId = Schema.decodeUnknownOption(Schema.Struct({ update_id: Schema.Number }));
const decodeBot = Schema.decodeUnknownOption(
  Schema.Struct({ username: Schema.optional(Schema.String) }),
);
const decodeSent = Schema.decodeUnknownOption(Schema.Struct({ message_id: Schema.Number }));

const failureFor = (code: number, retryAfter?: number) => {
  const fail = (value: TelegramApiErrorCode, outcome: "not_sent" | "unknown" = "not_sent") =>
    new TelegramApiError({
      code: value,
      outcome,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    });
  if (code === 401 || code === 404) return fail("invalid_token");
  if (code === 409) return fail("conflict");
  if (code === 429) return fail("rate_limited");
  if (code === 400) return fail("bad_request");
  if (code === 403) return fail("chat_not_found");
  return fail("unreachable", code >= 500 ? "unknown" : "not_sent");
};

export interface TelegramApi {
  readonly getMe: Effect.Effect<{ readonly username: string | undefined }, TelegramApiError>;
  readonly getUpdates: (input: {
    readonly offset: number;
    readonly timeoutSeconds: number;
  }) => Effect.Effect<ReadonlyArray<TelegramUpdate>, TelegramApiError>;
  /** Sends the HTML; when Telegram refuses it (400), the plain copy goes instead. */
  readonly sendMessage: (input: {
    readonly chatId: string;
    readonly text: TelegramText;
  }) => Effect.Effect<{ readonly messageId: string }, TelegramApiError>;
  /** Replaces the bot's "/" menu. */
  readonly setMyCommands: (
    commands: ReadonlyArray<{ readonly command: string; readonly description: string }>,
  ) => Effect.Effect<void, TelegramApiError>;
}

export const makeTelegramApi = (
  http: HttpClient.HttpClient,
  token: Redacted.Redacted<string>,
): TelegramApi => {
  const call = (method: string, body: unknown, timeoutSeconds: number) =>
    http
      .execute(
        HttpClientRequest.post(`${API_ORIGIN}/bot${Redacted.value(token)}/${method}`).pipe(
          HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
        ),
      )
      .pipe(
        // Redirects and cookies are never wanted from an API that holds a secret in its URL.
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
        }),
        Effect.flatMap((response) =>
          Effect.map(response.text, (text) => ({ status: response.status, text })),
        ),
        Effect.timeoutOrElse({
          duration: `${timeoutSeconds + REQUEST_GRACE_SECONDS} seconds`,
          orElse: () => Effect.fail(new TelegramApiError({ code: "timeout", outcome: "unknown" })),
        }),
        // A transport error carries the request, and so the token: it is replaced, never wrapped.
        Effect.mapError((error) =>
          Predicate.isTagged(error, "TelegramApiError")
            ? error
            : new TelegramApiError({ code: "unreachable", outcome: "unknown" }),
        ),
        Effect.flatMap(({ status, text }) => {
          const envelope = decodeEnvelope(text);
          if (envelope._tag === "None") {
            return Effect.fail(failureFor(status === 200 ? 502 : status));
          }
          const value = envelope.value;
          return value.ok
            ? Effect.succeed(value.result)
            : Effect.fail(failureFor(value.error_code ?? status, value.parameters?.retry_after));
        }),
        Effect.withSpan(`TelegramApi.${method}`),
      );

  return {
    setMyCommands: (commands) => call("setMyCommands", { commands }, 0).pipe(Effect.asVoid),
    getMe: call("getMe", {}, 0).pipe(
      Effect.map((result) => {
        const bot = decodeBot(result);
        return { username: bot._tag === "Some" ? bot.value.username : undefined };
      }),
    ),
    getUpdates: ({ offset, timeoutSeconds }) =>
      call(
        "getUpdates",
        { offset, timeout: timeoutSeconds, limit: 50, allowed_updates: ["message"] },
        timeoutSeconds,
      ).pipe(
        Effect.map((result) =>
          // One malformed update never hides the others; it is still acknowledged by its id.
          (Array.isArray(result) ? (result as ReadonlyArray<unknown>) : []).flatMap((raw) => {
            const id = decodeUpdateId(raw);
            if (id._tag === "None") return [];
            const message = decodeMessage((raw as { message?: unknown }).message);
            return [
              {
                updateId: id.value.update_id,
                message: message._tag === "Some" ? message.value : undefined,
              } satisfies TelegramUpdate,
            ];
          }),
        ),
      ),
    sendMessage: ({ chatId, text }) => {
      const send = (body: { readonly text: string; readonly parse_mode?: "HTML" }) =>
        call(
          "sendMessage",
          { chat_id: chatId, ...body, link_preview_options: { is_disabled: true } },
          0,
        );
      // A 400 means nothing was sent; a chat that is really gone fails the plain send the same way.
      return send({ text: text.html, parse_mode: "HTML" }).pipe(
        Effect.catchIf(
          (error) => error.code === "bad_request",
          () => send({ text: text.plain }),
        ),
        Effect.map((result) => {
          const sent = decodeSent(result);
          return { messageId: sent._tag === "Some" ? String(sent.value.message_id) : "" };
        }),
      );
    },
  };
};
