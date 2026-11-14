import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";

import { makeTelegramApi, type TelegramApi, type TelegramApiError } from "./telegramApi.ts";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_secret";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Runs `call` against a fetch that answers with `respond`, returning what was requested. */
const withFetch = <A, E>(
  respond: (url: string, body: unknown) => Response | Promise<Response>,
  call: (api: TelegramApi) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const requests: Array<{ url: string; body: unknown; init: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url: String(url), body, init: init ?? {} });
      return respond(String(url), body);
    };
    const http = yield* HttpClient.HttpClient;
    const exit = yield* Effect.exit(
      call(makeTelegramApi(http, Redacted.make(TOKEN))).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );
    return { exit, requests };
  }).pipe(Effect.provide(FetchHttpClient.layer));

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
  assert.isTrue(error?._tag === "Some");
  return error?._tag === "Some" ? (error.value as TelegramApiError) : undefined;
};

it.effect(
  "reads the bot, sends HTML, falls back to the plain copy on a 400, and posts to the token's own URL",
  () =>
    Effect.gen(function* () {
      const me = yield* withFetch(
        () => json({ ok: true, result: { id: 1, username: "my_bot" } }),
        (api) => api.getMe,
      );
      assert.deepStrictEqual(Exit.isSuccess(me.exit) && me.exit.value, { username: "my_bot" });
      assert.strictEqual(me.requests[0]?.url, `https://api.telegram.org/bot${TOKEN}/getMe`);
      assert.strictEqual(me.requests[0]?.init.redirect, "manual");
      assert.strictEqual(me.requests[0]?.init.credentials, "omit");

      const sent = yield* withFetch(
        () => json({ ok: true, result: { message_id: 77 } }),
        (api) =>
          api.sendMessage({ chatId: "42", text: { html: "<b>a &lt; b</b>", plain: "a < b" } }),
      );
      assert.deepStrictEqual(Exit.isSuccess(sent.exit) && sent.exit.value, { messageId: "77" });
      assert.lengthOf(sent.requests, 1);
      const body = sent.requests[0]?.body as Record<string, unknown>;
      assert.strictEqual(body.chat_id, "42");
      assert.strictEqual(body.text, "<b>a &lt; b</b>");
      assert.strictEqual(body.parse_mode, "HTML");

      // HTML Telegram cannot parse is refused with a 400; the plain copy goes instead, once.
      const fallback = yield* withFetch(
        (_url, request) =>
          (request as { parse_mode?: string }).parse_mode === "HTML"
            ? json(
                { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
                400,
              )
            : json({ ok: true, result: { message_id: 78 } }),
        (api) => api.sendMessage({ chatId: "42", text: { html: "<b>broken", plain: "broken" } }),
      );
      assert.deepStrictEqual(Exit.isSuccess(fallback.exit) && fallback.exit.value, {
        messageId: "78",
      });
      assert.lengthOf(fallback.requests, 2);
      const plainBody = fallback.requests[1]?.body as Record<string, unknown>;
      assert.strictEqual(plainBody.text, "broken");
      assert.isFalse("parse_mode" in plainBody);

      // A reply without a readable id still counts as sent.
      const noId = yield* withFetch(
        () => json({ ok: true, result: true }),
        (api) => api.sendMessage({ chatId: "42", text: { html: "hi", plain: "hi" } }),
      );
      assert.deepStrictEqual(Exit.isSuccess(noId.exit) && noId.exit.value, { messageId: "" });
      const noName = yield* withFetch(
        () => json({ ok: true, result: {} }),
        (api) => api.getMe,
      );
      assert.deepStrictEqual(Exit.isSuccess(noName.exit) && noName.exit.value, {
        username: undefined,
      });
    }),
);

it.effect("keeps every readable update, and acknowledges one that is not a message", () =>
  Effect.gen(function* () {
    const { exit, requests } = yield* withFetch(
      () =>
        json({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                message_id: 1,
                date: 1_800_000_000,
                text: "hi",
                chat: { id: 5, type: "private" },
                from: { id: 5, first_name: "Ana", language_code: "pt", is_premium: true },
              },
            },
            { update_id: 11, edited_message: { message_id: 2 } },
            { update_id: 12, message: { message_id: "broken" } },
            { no_update_id: true },
          ],
        }),
      (api) => api.getUpdates({ offset: 10, timeoutSeconds: 25 }),
    );
    assert.isTrue(Exit.isSuccess(exit));
    const updates = Exit.isSuccess(exit) ? exit.value : [];
    assert.deepStrictEqual(
      updates.map((update) => [update.updateId, update.message?.text]),
      [
        [10, "hi"],
        [11, undefined],
        [12, undefined],
      ],
    );
    assert.deepStrictEqual(requests[0]?.body, {
      offset: 10,
      timeout: 25,
      limit: 50,
      allowed_updates: ["message"],
    });
    const none = yield* withFetch(
      () => json({ ok: true, result: "nope" }),
      (api) => api.getUpdates({ offset: 0, timeoutSeconds: 0 }),
    );
    assert.deepStrictEqual(Exit.isSuccess(none.exit) && none.exit.value, []);
  }),
);

it.effect("turns every failure into a fixed code that never carries the token", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<
      readonly [Response | (() => Promise<Response>), string, "not_sent" | "unknown", number?]
    > = [
      [
        json({ ok: false, error_code: 401, description: "Unauthorized" }, 401),
        "invalid_token",
        "not_sent",
      ],
      [new Response("Not Found", { status: 404 }), "invalid_token", "not_sent"],
      [json({ ok: false, error_code: 409, description: "Conflict" }, 409), "conflict", "not_sent"],
      [
        json({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429),
        "rate_limited",
        "not_sent",
        7,
      ],
      [json({ ok: false, error_code: 403 }, 403), "chat_not_found", "not_sent"],
      [json({ ok: false, error_code: 400 }, 400), "bad_request", "not_sent"],
      [json({ ok: false, error_code: 502 }, 502), "unreachable", "unknown"],
      [json({ ok: false, error_code: 418 }, 418), "unreachable", "not_sent"],
      [new Response("<html>", { status: 200 }), "unreachable", "unknown"],
      [
        async () => {
          throw new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/getMe`);
        },
        "unreachable",
        "unknown",
      ],
    ];
    for (const [response, code, outcome, retryAfter] of cases) {
      const { exit } = yield* withFetch(
        async () => (typeof response === "function" ? response() : response.clone()),
        (api) => api.sendMessage({ chatId: "1", text: { html: "x", plain: "x" } }),
      );
      const error = failureOf(exit);
      assert.strictEqual(error?.code, code);
      assert.strictEqual(error?.outcome, outcome);
      assert.strictEqual(error?.retryAfterSeconds, retryAfter);
      assert.isFalse(JSON.stringify(error).includes("secret"));
      assert.isFalse(String(error?.message).includes("secret"));
    }
  }),
);

const FILE_URL = `https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`;

it.effect("downloads a file by its id, and never more bytes than allowed", () =>
  Effect.gen(function* () {
    const answer = (bytes: Uint8Array, fileSize?: number) => (url: string) =>
      url.endsWith("/getFile")
        ? json({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: fileSize } })
        : new Response(bytes, { status: 200 });
    const got = yield* withFetch(answer(new Uint8Array([1, 2, 3])), (api) =>
      api.downloadFile({ fileId: "abc", maxBytes: 3 }),
    );
    assert.deepStrictEqual(Exit.isSuccess(got.exit) && [...got.exit.value], [1, 2, 3]);
    assert.deepStrictEqual(got.requests[0]?.body, { file_id: "abc" });
    assert.strictEqual(got.requests[1]?.url, FILE_URL);
    assert.strictEqual(got.requests[1]?.init.redirect, "manual");

    // Telegram's own size is checked first, and the stream is cut even when it lied.
    const declared = yield* withFetch(answer(new Uint8Array(2), 9), (api) =>
      api.downloadFile({ fileId: "abc", maxBytes: 3 }),
    );
    assert.strictEqual(failureOf(declared.exit)?.code, "too_large");
    assert.lengthOf(declared.requests, 1);
    const streamed = yield* withFetch(answer(new Uint8Array(4)), (api) =>
      api.downloadFile({ fileId: "abc", maxBytes: 3 }),
    );
    assert.strictEqual(failureOf(streamed.exit)?.code, "too_large");
  }),
);

it.effect(
  "refuses a file path that leaves the bot's files, and keeps the token out of errors",
  () =>
    Effect.gen(function* () {
      for (const filePath of ["../bot1/getMe", "photos/../../x", "/etc/passwd", "a?b", ""]) {
        const result = yield* withFetch(
          () => json({ ok: true, result: { file_path: filePath } }),
          (api) => api.downloadFile({ fileId: "abc", maxBytes: 3 }),
        );
        assert.strictEqual(failureOf(result.exit)?.code, "bad_request", filePath);
        assert.lengthOf(result.requests, 1, filePath);
      }
      const failures = [
        () => {
          throw new Error(`connect failed for ${FILE_URL}`);
        },
        () => new Response(`not found: ${FILE_URL}`, { status: 404 }),
        () => new Response(`oops ${TOKEN}`, { status: 500 }),
      ];
      for (const fail of failures) {
        const result = yield* withFetch(
          (url) =>
            url.endsWith("/getFile")
              ? json({ ok: true, result: { file_path: "photos/file_1.jpg" } })
              : fail(),
          (api) => api.downloadFile({ fileId: "abc", maxBytes: 3 }),
        );
        const error = failureOf(result.exit);
        assert.notInclude(JSON.stringify(error), "secret");
        assert.notInclude(String(error?.message), "secret");
        assert.notInclude(
          JSON.stringify(Exit.isFailure(result.exit) ? result.exit.cause : ""),
          "secret",
        );
      }
    }),
);
