import { assert, it } from "@effect/vitest";

import type { TelegramMessage, TelegramUpdate } from "./telegramApi.ts";
import { admitTelegramUpdate } from "./telegramAdmission.ts";

const ALLOWED = new Set(["111"]);

const update = (patch: Partial<TelegramMessage> | undefined, updateId = 9): TelegramUpdate => ({
  updateId,
  message:
    patch === undefined
      ? undefined
      : {
          message_id: 4,
          date: 1_800_000_000,
          text: "hello",
          chat: { id: 111, type: "private" },
          from: { id: 111, first_name: " Ana " },
          ...patch,
        },
});

const skipReason = (input: TelegramUpdate) => {
  const admission = admitTelegramUpdate(input, ALLOWED, "telegram");
  return admission.type === "skip" ? admission.reason : "message";
};

it("hears only allowed people writing to the bot in a private chat", () => {
  assert.strictEqual(skipReason(update(undefined)), "kind");
  assert.strictEqual(skipReason(update({ chat: { id: -5, type: "supergroup" } })), "chat");
  assert.strictEqual(skipReason(update({ from: undefined })), "sender");
  assert.strictEqual(skipReason(update({ from: { id: 111, is_bot: true } })), "sender");
  assert.strictEqual(skipReason(update({ text: "   " })), "text");
  assert.strictEqual(skipReason(update({})), "message");
});

it("reports a private message from an unknown person so the owner can allow them", () => {
  const admission = admitTelegramUpdate(
    update({ from: { id: 222, first_name: " Bo ", username: "bo_x" } }),
    ALLOWED,
    "telegram",
  );
  assert.deepStrictEqual(admission, {
    type: "unknown_sender",
    chatId: "111",
    sender: { userId: "222", firstName: "Bo", username: "bo_x" },
  });
  const bare = admitTelegramUpdate(update({ from: { id: 333 }, text: undefined }), ALLOWED, "t");
  assert.deepStrictEqual(bare.type === "unknown_sender" && bare.sender, { userId: "333" });
});

it("hands the gateway a message keyed by chat and update, so a redelivery is one message", () => {
  const admission = admitTelegramUpdate(
    update({ text: "  @Jarvis hi  " }, 42),
    ALLOWED,
    "telegram",
  );
  assert.deepStrictEqual(admission.type === "message" && admission.inbound, {
    kind: "telegram",
    connectionId: "telegram",
    conversationKey: "111",
    externalMessageId: "4",
    idempotencyKey: "telegram:42",
    actor: { externalActorId: "111", displayName: "Ana" },
    replyAddress: { kind: "telegram", connectionId: "telegram", chatId: "111" },
    text: "@Jarvis hi",
    receivedAt: "2027-01-15T08:00:00.000Z",
  });
});

it("reads /start as a request for the roster, and clamps an impossible date", () => {
  for (const text of ["/start", "/start@my_bot", "/START now"]) {
    const admission = admitTelegramUpdate(update({ text }), ALLOWED, "telegram");
    assert.strictEqual(admission.type === "message" && admission.inbound.text, "@");
  }
  const kept = admitTelegramUpdate(update({ text: "/starting" }), ALLOWED, "telegram");
  assert.strictEqual(kept.type === "message" && kept.inbound.text, "/starting");
  const far = admitTelegramUpdate(
    update({ date: Number.MAX_SAFE_INTEGER, from: { id: 111 } }),
    ALLOWED,
    "telegram",
  );
  assert.strictEqual(far.type === "message" && far.inbound.receivedAt, "2100-01-01T00:00:00.000Z");
  assert.isUndefined(far.type === "message" ? far.inbound.actor.displayName : "x");
});

const media = (input: TelegramUpdate) => {
  const admission = admitTelegramUpdate(input, ALLOWED, "telegram");
  if (admission.type !== "message") throw new Error(`expected a message, got ${admission.type}`);
  return {
    text: admission.inbound.text,
    problem: admission.inbound.attachmentProblem,
    media: admission.media,
    group: admission.mediaGroupId,
  };
};

const photo = (fileId: string, width: number, fileSize?: number) => ({
  file_id: fileId,
  width,
  height: width,
  ...(fileSize === undefined ? {} : { file_size: fileSize }),
});

it("hands on a photo's largest size with its caption as the text", () => {
  const sizes = [photo("small", 90, 900), photo("large", 1280, 90_000), photo("mid", 320, 9000)];
  assert.deepStrictEqual(media(update({ text: undefined, caption: " look ", photo: sizes })), {
    text: "look",
    problem: undefined,
    media: [{ fileId: "large", name: "photo.jpg" }],
    group: undefined,
  });
  assert.deepStrictEqual(media(update({ text: undefined, photo: sizes })).text, "");
  // A caption is never read as /start.
  assert.strictEqual(
    media(update({ text: undefined, caption: "/start", photo: sizes })).text,
    "/start",
  );
});

it("hands on an image sent as a file and keys album members by their group", () => {
  assert.deepStrictEqual(
    media(
      update({
        text: undefined,
        media_group_id: "album-1",
        document: { file_id: "doc", file_name: "scan.PNG", mime_type: "image/png", file_size: 10 },
      }),
    ),
    {
      text: "",
      problem: undefined,
      media: [{ fileId: "doc", name: "scan.PNG" }],
      group: "album-1",
    },
  );
  // The name is a hint; the bytes decide later.
  assert.lengthOf(
    media(update({ text: undefined, document: { file_id: "d", file_name: "x.webp" } })).media,
    1,
  );
});

it("answers whatever it cannot read instead of dropping it", () => {
  const cases: ReadonlyArray<Partial<TelegramMessage>> = [
    { text: undefined },
    { text: undefined, caption: "a clip" },
    {
      text: undefined,
      document: { file_id: "d", file_name: "notes.pdf", mime_type: "application/pdf" },
    },
    // Larger than an image attachment may be; never downloaded.
    {
      text: undefined,
      document: {
        file_id: "d",
        file_name: "big.png",
        mime_type: "image/png",
        file_size: 10 * 1024 * 1024 + 1,
      },
    },
    { text: undefined, photo: [photo("huge", 4000, 10 * 1024 * 1024 + 1)] },
  ];
  for (const patch of cases) {
    const read = media(update(patch));
    assert.strictEqual(read.problem, "unsupported");
    assert.lengthOf(read.media, 0);
  }
  // The allowlist still comes first: a stranger's sticker is reported, a group's is ignored.
  assert.strictEqual(
    admitTelegramUpdate(update({ text: undefined, from: { id: 222 } }), ALLOWED, "t").type,
    "unknown_sender",
  );
  assert.strictEqual(
    skipReason(
      update({ text: undefined, photo: [photo("p", 9)], chat: { id: -5, type: "group" } }),
    ),
    "chat",
  );
  assert.strictEqual(
    skipReason(
      update({ text: undefined, photo: [photo("p", 9)], from: { id: 111, is_bot: true } }),
    ),
    "sender",
  );
});
