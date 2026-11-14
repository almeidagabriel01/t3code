import { describe, expect, it } from "vite-plus/test";

import {
  admitImessageRow,
  appleDateToEpochMs,
  appleDateToIso,
  extractTypedstreamText,
  fingerprintText,
  toImessageInbound,
  type ImessageAdmission,
  type ImessageAdmissionMemory,
} from "./imessageAdmission.ts";
import type { ImessageRow } from "./imessageChatDb.ts";
import { normalizeHandle } from "./imessageHandles.ts";

const FRIEND = "+15550000001";
const ME = "+15550000002";
const ME_MAIL = "me@example.com";
const CHAT = `iMessage;-;${ME}`;
const config = {
  allowedHandles: new Set([FRIEND]),
  selfHandles: new Set([ME, ME_MAIL]),
};
const NOW_MS = 1_800_000_000_000;
const dateAt = (epochMs: number) => (epochMs - 978_307_200_000) * 1_000_000;
const DATE = dateAt(NOW_MS);
const empty: ImessageAdmissionMemory = { sent: [], seen: [] };

const friendRow = (patch: Partial<ImessageRow> = {}): ImessageRow => ({
  rowid: 10,
  guid: "guid-10",
  text: "hello",
  attributedBody: null,
  is_from_me: 0,
  date: DATE,
  associated_message_type: 0,
  item_type: 0,
  balloon_bundle_id: null,
  cache_has_attachments: 0,
  message_service: "iMessage",
  sender_handle: FRIEND,
  sender_service: "iMessage",
  chat_guid: `iMessage;-;${FRIEND}`,
  chat_identifier: FRIEND,
  style: 45,
  chat_join_count: 1,
  account: null,
  ...patch,
});
const selfRow = (patch: Partial<ImessageRow> = {}): ImessageRow =>
  friendRow({
    is_from_me: 1,
    sender_handle: null,
    sender_service: null,
    chat_guid: CHAT,
    chat_identifier: ME,
    ...patch,
  });

const typedstream = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array([
    ...new TextEncoder().encode(
      "streamtyped\u0081è\u0003\u0084\u0001@\u0084\u0084\u0084\u0012NSAttributedString",
    ),
    0,
    ...new TextEncoder().encode("NSString"),
    1,
    0x94,
    0x84,
    0x01,
    0x2b,
    ...(bytes.length < 0x80 ? [bytes.length] : [0x81, bytes.length & 0xff, bytes.length >> 8]),
    ...bytes,
    0x86,
  ]);
};

const sentFor = (text: string, extra: Partial<ImessageAdmissionMemory["sent"][number]> = {}) => ({
  id: 7,
  chatGuid: CHAT,
  textHash: fingerprintText(text),
  sentAtMs: NOW_MS,
  ...extra,
});

const MESSAGE = "message";
interface Case {
  readonly name: string;
  readonly row: ImessageRow;
  readonly memory?: ImessageAdmissionMemory;
  readonly expect: string;
  readonly check?: (admission: ImessageAdmission) => void;
}
const cases: ReadonlyArray<Case> = [
  {
    name: "other account: allowed handle admitted",
    row: friendRow(),
    expect: MESSAGE,
    check: (a) => {
      expect(a).toMatchObject({
        via: "other_account",
        senderHandle: FRIEND,
        chatGuid: `iMessage;-;${FRIEND}`,
        text: "hello",
      });
      expect((a as { remember?: unknown }).remember).toBeUndefined();
    },
  },
  {
    name: "other account: handle not allowed",
    row: friendRow({ sender_handle: "+15559999999" }),
    expect: "sender",
  },
  {
    name: "other account: handle in a different case",
    row: friendRow({ sender_handle: " +1 (555) 000-0001 " }),
    expect: MESSAGE,
  },
  { name: "other account: sms", row: friendRow({ sender_service: "SMS" }), expect: "service" },
  { name: "other account: group chat", row: friendRow({ style: 43 }), expect: "chat" },
  { name: "other account: two chats", row: friendRow({ chat_join_count: 2 }), expect: "chat" },
  { name: "other account: no chat guid", row: friendRow({ chat_guid: null }), expect: "chat" },
  {
    name: "other account: attachment flag is answered, never dropped",
    row: friendRow({ cache_has_attachments: 1, text: null }),
    expect: "message",
    check: (admission) => expect(admission).toMatchObject({ text: "", attachment: true }),
  },
  {
    name: "other account: attachment placeholder keeps its caption",
    row: friendRow({ text: "￼ look" }),
    expect: "message",
    check: (admission) => expect(admission).toMatchObject({ text: "look", attachment: true }),
  },
  {
    name: "other account: an attachment in a group is still not read",
    row: friendRow({ cache_has_attachments: 1, chat_join_count: 2 }),
    expect: "chat",
  },
  {
    name: "an attachment from someone not allowed is still not read",
    row: friendRow({ cache_has_attachments: 1, sender_handle: "+15559999999" }),
    expect: "sender",
  },
  {
    name: "other account: tapback",
    row: friendRow({ associated_message_type: 2000 }),
    expect: "unsupported_kind",
  },
  {
    name: "other account: app balloon",
    row: friendRow({ balloon_bundle_id: "com.apple.messages.URLBalloonProvider" }),
    expect: "unsupported_kind",
  },
  {
    name: "other account: group event",
    row: friendRow({ item_type: 1 }),
    expect: "unsupported_kind",
  },
  { name: "other account: no guid", row: friendRow({ guid: null }), expect: "sender" },
  { name: "other account: empty text", row: friendRow({ text: "  " }), expect: "text" },
  { name: "other account: no text and no body", row: friendRow({ text: null }), expect: "text" },
  {
    name: "other account: text from the archived body",
    row: friendRow({ text: null, attributedBody: typedstream("from the blob") }),
    expect: MESSAGE,
    check: (a) => expect(a).toMatchObject({ text: "from the blob" }),
  },
  {
    name: "other account: not joined yet",
    row: friendRow({ chat_join_count: 0 }),
    expect: "pending_join",
  },
  {
    name: "other account: a sender that is also yours is not an other account",
    row: friendRow({ sender_handle: ME }),
    expect: "other_chat",
  },
  {
    name: "self chat: own message in the chat with yourself",
    row: selfRow(),
    expect: MESSAGE,
    check: (a) => {
      expect(a).toMatchObject({ via: "self_chat", senderHandle: ME, chatGuid: CHAT });
      expect((a as { remember?: unknown }).remember).toEqual({
        chatGuid: CHAT,
        textHash: fingerprintText("hello"),
        dateMs: NOW_MS,
      });
    },
  },
  {
    name: "self chat: by email handle",
    row: selfRow({ chat_guid: `iMessage;-;${ME_MAIL}`, chat_identifier: ME_MAIL }),
    expect: MESSAGE,
  },
  {
    name: "self chat: mirrored copy from your own handle is admitted when seen first",
    row: selfRow({ is_from_me: 0, sender_handle: ME, sender_service: "iMessage" }),
    expect: MESSAGE,
  },
  {
    name: "self chat: reply this transport sent is skipped and consumed (is_from_me = 1)",
    row: selfRow({ text: "Jarvis: hi" }),
    memory: { sent: [sentFor("Jarvis: hi")], seen: [] },
    expect: "own_reply",
    check: (a) => expect(a).toMatchObject({ consumeSentId: 7 }),
  },
  {
    name: "self chat: echo of a reply arriving as is_from_me = 0 is skipped too",
    row: selfRow({
      is_from_me: 0,
      sender_handle: ME,
      sender_service: "iMessage",
      text: "Jarvis: hi",
    }),
    memory: { sent: [sentFor("Jarvis: hi")], seen: [] },
    expect: "own_reply",
  },
  {
    name: "self chat: whitespace differences still match the fingerprint",
    row: selfRow({ text: "Jarvis:  hi\n" }),
    memory: { sent: [sentFor("Jarvis: hi")], seen: [] },
    expect: "own_reply",
  },
  {
    name: "self chat: same text long after sending is the user's",
    row: selfRow({ text: "Jarvis: hi" }),
    memory: { sent: [sentFor("Jarvis: hi", { sentAtMs: NOW_MS - 31 * 60_000 })], seen: [] },
    expect: MESSAGE,
  },
  {
    name: "self chat: a reply sent to your other address echoes here and is still skipped",
    row: selfRow({ text: "Jarvis: hi" }),
    memory: { sent: [sentFor("Jarvis: hi", { chatGuid: `iMessage;-;${ME_MAIL}` })], seen: [] },
    expect: "own_reply",
  },
  {
    name: "self chat: the Mac sends from your email, so a message there is answered on your number",
    row: selfRow({
      chat_guid: `any;-;${ME_MAIL}`,
      chat_identifier: ME_MAIL,
      account: `E:${ME_MAIL}`,
    }),
    expect: MESSAGE,
    check: (a) =>
      expect(a).toMatchObject({
        chatGuid: `any;-;${ME}`,
        remember: { chatGuid: `any;-;${ME_MAIL}` },
      }),
  },
  {
    name: "self chat: on your number while the Mac sends from your email, it stays",
    row: selfRow({ account: `E:${ME_MAIL}` }),
    expect: MESSAGE,
    check: (a) => expect(a).toMatchObject({ chatGuid: CHAT }),
  },
  {
    name: "self chat: the Mac sends from your number, so the answer goes to your email",
    row: selfRow({ account: `p:${ME}` }),
    expect: MESSAGE,
    check: (a) => expect(a).toMatchObject({ chatGuid: `iMessage;-;${ME_MAIL}` }),
  },
  {
    name: "self chat: twin copy of a message already seen moments ago",
    row: selfRow({ is_from_me: 0, sender_handle: ME, sender_service: "iMessage" }),
    memory: {
      sent: [],
      seen: [{ chatGuid: CHAT, textHash: fingerprintText("hello"), dateMs: NOW_MS + 3_000 }],
    },
    expect: "mirrored",
  },
  {
    name: "self chat: same text again well after is a new message",
    row: selfRow(),
    memory: {
      sent: [],
      seen: [{ chatGuid: CHAT, textHash: fingerprintText("hello"), dateMs: NOW_MS - 60_000 }],
    },
    expect: MESSAGE,
  },
  {
    name: "self chat: other text at the same moment is a new message",
    row: selfRow({ text: "different" }),
    memory: {
      sent: [],
      seen: [{ chatGuid: CHAT, textHash: fingerprintText("hello"), dateMs: NOW_MS }],
    },
    expect: MESSAGE,
  },
  {
    name: "self chat: sms to yourself",
    row: selfRow({ message_service: "SMS" }),
    expect: "service",
  },
  {
    name: "self chat: not joined yet",
    row: selfRow({ chat_join_count: 0 }),
    expect: "pending_join",
  },
  {
    name: "self chat: attachment",
    row: selfRow({ cache_has_attachments: 1 }),
    expect: "message",
    check: (admission) => expect(admission).toMatchObject({ attachment: true }),
  },
  {
    name: "your attachment to a friend is never answered",
    row: selfRow({
      cache_has_attachments: 1,
      chat_guid: `iMessage;-;${FRIEND}`,
      chat_identifier: FRIEND,
    }),
    expect: "other_chat",
  },
  {
    name: "self chat: tapback",
    row: selfRow({ associated_message_type: 2001 }),
    expect: "unsupported_kind",
  },
  { name: "self chat: a group that contains you", row: selfRow({ style: 43 }), expect: "chat" },
  {
    name: "your message to a friend is never read",
    row: selfRow({ chat_guid: `iMessage;-;${FRIEND}`, chat_identifier: FRIEND }),
    expect: "other_chat",
  },
  {
    name: "your message in a group is never read",
    row: selfRow({ chat_guid: "iMessage;+;chat123", chat_identifier: "chat123", style: 43 }),
    expect: "chat",
  },
  {
    name: "message from someone to a chat you are not in",
    row: friendRow({ sender_handle: null }),
    expect: "sender",
  },
];

describe("admitImessageRow", () => {
  it.each(cases)("$name", (testCase) => {
    const admission = admitImessageRow(testCase.row, config, testCase.memory ?? empty);
    expect(admission.type === "skip" ? admission.reason : admission.type).toBe(testCase.expect);
    testCase.check?.(admission);
  });

  it("remembers a skipped echo so its twin is skipped as mirrored", () => {
    const echo = admitImessageRow(selfRow({ text: "Jarvis: hi" }), config, {
      sent: [sentFor("Jarvis: hi")],
      seen: [],
    });
    expect(echo).toMatchObject({ remember: { textHash: fingerprintText("Jarvis: hi") } });
    const twin = admitImessageRow(
      selfRow({ is_from_me: 0, sender_handle: ME, sender_service: "iMessage", text: "Jarvis: hi" }),
      config,
      {
        sent: [],
        seen: [(echo as { remember: ImessageAdmissionMemory["seen"][number] }).remember],
      },
    );
    expect(twin).toMatchObject({ type: "skip", reason: "mirrored" });
  });
});

describe("toImessageInbound", () => {
  it("keys the conversation by chat and the message by its guid", () => {
    const admission = admitImessageRow(friendRow(), config, empty);
    if (admission.type !== "message") throw new Error("expected a message");
    expect(toImessageInbound(admission, "imessage")).toEqual({
      kind: "imessage",
      connectionId: "imessage",
      conversationKey: `iMessage;-;${FRIEND}`,
      externalMessageId: "guid-10",
      idempotencyKey: "imessage:guid-10",
      actor: { externalActorId: FRIEND },
      replyAddress: {
        kind: "imessage",
        connectionId: "imessage",
        chatGuid: `iMessage;-;${FRIEND}`,
      },
      text: "hello",
      receivedAt: appleDateToIso(DATE, 10),
    });
  });

  it("marks an attachment it cannot pass on, so the bridge answers it", () => {
    const admission = admitImessageRow(friendRow({ cache_has_attachments: 1 }), config, empty);
    if (admission.type !== "message") throw new Error("expected a message");
    expect(toImessageInbound(admission, "imessage")).toMatchObject({
      text: "hello",
      attachmentProblem: "unsupported",
    });
  });
});

describe("extractTypedstreamText", () => {
  const long = "x".repeat(300);
  const rows: ReadonlyArray<readonly [string, Uint8Array | null, string | undefined]> = [
    ["null", null, undefined],
    ["short", typedstream("hi there"), "hi there"],
    ["two-byte length", typedstream(long), long],
    ["unicode", typedstream("olá 🐐"), "olá 🐐"],
    ["no marker", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), undefined],
    ["too large", new Uint8Array(70_000), undefined],
    [
      "marker without plus",
      new TextEncoder().encode("NSString................................"),
      undefined,
    ],
    [
      "truncated payload",
      typedstream("hello").subarray(0, typedstream("hello").length - 6),
      undefined,
    ],
    [
      "invalid utf-8",
      new Uint8Array([...new TextEncoder().encode("NSString"), 0x2b, 2, 0xff, 0xfe]),
      undefined,
    ],
    [
      "unknown length head",
      new Uint8Array([...new TextEncoder().encode("NSString"), 0x2b, 0x90, 1, 2, 3]),
      undefined,
    ],
    [
      "empty payload",
      new Uint8Array([...new TextEncoder().encode("NSString"), 0x2b, 0, 0]),
      undefined,
    ],
    [
      "four-byte length",
      new Uint8Array([...new TextEncoder().encode("NSString"), 0x2b, 0x82, 2, 0, 0, 0, 0x68, 0x69]),
      "hi",
    ],
    [
      "cut length",
      new Uint8Array([...new TextEncoder().encode("NSString"), 0x2b, 0x81, 2]),
      undefined,
    ],
    [
      "cut four-byte length",
      new Uint8Array([...new TextEncoder().encode("NSString"), 0x2b, 0x82, 2, 0]),
      undefined,
    ],
    [
      "ends at the head",
      new Uint8Array([...new TextEncoder().encode("NSString"), 0x2b]),
      undefined,
    ],
  ];
  it.each(rows)("%s", (_name, body, expected) => {
    expect(extractTypedstreamText(body)).toBe(expected);
  });
});

describe("Apple dates", () => {
  const rows: ReadonlyArray<readonly [string, number, number | undefined]> = [
    ["nanoseconds", dateAt(NOW_MS), NOW_MS],
    ["seconds", (NOW_MS - 978_307_200_000) / 1000, NOW_MS],
    ["zero is the Apple epoch", 0, 978_307_200_000],
    ["negative", -5, undefined],
    ["far future", 9e18, undefined],
    ["not finite", Number.NaN, undefined],
  ];
  it.each(rows)("%s", (_name, date, expected) => {
    expect(appleDateToEpochMs(date)).toBe(expected);
  });

  it("falls back to a stable time derived from the row when the date is unusable", () => {
    expect(appleDateToIso(-5, 10)).toBe("2001-01-01T00:00:00.010Z");
    expect(appleDateToIso(dateAt(NOW_MS), 1)).toBe("2027-01-15T08:00:00.000Z");
  });
});

describe("normalizeHandle", () => {
  const rows: ReadonlyArray<readonly [string, string | undefined]> = [
    ["+1 (555) 000-0001", "+15550000001"],
    ["+55 11 91234-5678", "+5511912345678"],
    ["+1.555.000.0001", "+15550000001"],
    [" Person@Example.COM ", "person@example.com"],
    ["5550000001", undefined],
    ["+0123456", undefined],
    ["+12", undefined],
    ["not a handle", undefined],
    ["a@b", undefined],
    ["", undefined],
  ];
  it.each(rows)("%s", (raw, expected) => {
    expect(normalizeHandle(raw)).toBe(expected);
  });
});
