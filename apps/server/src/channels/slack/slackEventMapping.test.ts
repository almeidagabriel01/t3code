import { describe, expect, it } from "vite-plus/test";

import {
  classifySlackEvent,
  classifySlackInteraction,
  slackReplyAddress,
  toSlackInboundMessage,
  type SlackClassifierConfig,
} from "./slackEventMapping.ts";

const config: SlackClassifierConfig = {
  teamId: "T0000000001",
  botUserId: "U0000000002",
  allowedChannelIds: new Set(["C0000000001"]),
};

const envelope = (event: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  type: "event_callback",
  team_id: "T0000000001",
  event_id: "Ev0001AAAA",
  event,
  ...overrides,
});

const mention = (overrides: Record<string, unknown> = {}) => ({
  type: "app_mention",
  channel: "C0000000001",
  user: "U0000000001",
  text: "<@U0000000002> fix the login bug",
  ts: "1760000000.000100",
  ...overrides,
});

const directMessage = (overrides: Record<string, unknown> = {}) => ({
  type: "message",
  channel_type: "im",
  channel: "D0000000001",
  user: "U0000000001",
  text: "what is running?",
  ts: "1760000000.000200",
  ...overrides,
});

const withoutUser = ({ user: _user, ...event }: Record<string, unknown>) => event;

describe("classifySlackEvent", () => {
  it("treats a channel mention as the root of its own thread", () => {
    expect(classifySlackEvent(envelope(mention()), config)).toEqual({
      _tag: "message",
      event: {
        teamId: "T0000000001",
        channelId: "C0000000001",
        surface: "mention",
        userId: "U0000000001",
        ts: "1760000000.000100",
        rootTs: "1760000000.000100",
        eventId: "Ev0001AAAA",
        dedupeKey: "T0000000001:Ev0001AAAA",
        conversationKey: "T0000000001:C0000000001",
        text: "fix the login bug",
      },
    });
  });

  it("keeps a channel mention's thread as the reply target but one conversation per channel", () => {
    const first = classifySlackEvent(
      envelope(mention({ ts: "1760000000.000300", thread_ts: "1760000000.000100" }), {
        event_id: "Ev0002BBBB",
      }),
      config,
    );
    const second = classifySlackEvent(
      envelope(mention({ ts: "1760000000.000400", thread_ts: "1760000000.000100" }), {
        event_id: "Ev0003CCCC",
      }),
      config,
    );
    if (first._tag !== "message" || second._tag !== "message") throw new Error("expected messages");
    expect(first.event.rootTs).toBe("1760000000.000100");
    expect(first.event.conversationKey).toBe("T0000000001:C0000000001");
    expect(first.event.conversationKey).toBe(second.event.conversationKey);
    expect(first.event.dedupeKey).not.toBe(second.event.dedupeKey);
  });

  it("accepts direct messages without an allowlist entry", () => {
    const result = classifySlackEvent(envelope(directMessage()), config);
    if (result._tag !== "message") throw new Error("expected a message");
    expect(result.event.surface).toBe("dm");
    expect(result.event.conversationKey).toBe("T0000000001:D0000000001");
    expect(result.event.rootTs).toBeUndefined();
  });

  it("replies to a direct message top-level unless it was written inside a thread", () => {
    const top = classifySlackEvent(envelope(directMessage()), config);
    const threaded = classifySlackEvent(
      envelope(directMessage({ thread_ts: "1760000000.000100" })),
      config,
    );
    if (top._tag !== "message" || threaded._tag !== "message") throw new Error("expected messages");
    expect(slackReplyAddress(top.event, "slack-1")).not.toHaveProperty("rootTs");
    expect(slackReplyAddress(threaded.event, "slack-1").rootTs).toBe("1760000000.000100");
    expect(top.event.conversationKey).toBe(threaded.event.conversationKey);
  });

  it("gives Slack retries of one event the same dedupe key", () => {
    const body = envelope(mention());
    const first = classifySlackEvent(body, config);
    const retry = classifySlackEvent(structuredClone(body), config);
    if (first._tag !== "message" || retry._tag !== "message") throw new Error("expected messages");
    expect(retry.event.dedupeKey).toBe(first.event.dedupeKey);
  });

  const richBlocks = [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "user", user_id: "U0000000002" },
            { type: "text", text: " 배포 확인해줘 " },
            { type: "emoji", name: "rocket" },
            { type: "broadcast", range: "channel" },
          ],
        },
        {
          type: "rich_text_list",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "see " },
                { type: "link", url: "https://github.com/a/b/pull/1" },
              ],
            },
            { type: "rich_text_section", elements: [{ type: "channel", channel_id: "C0OPS" }] },
          ],
        },
      ],
    },
  ];

  it("reads the rich text blocks of a message whose text is empty", () => {
    const result = classifySlackEvent(envelope(mention({ text: "", blocks: richBlocks })), config);
    if (result._tag !== "message") throw new Error("expected a message");
    expect(result.event.text).toBe(
      "배포 확인해줘 :rocket:\nsee https://github.com/a/b/pull/1\n<#C0OPS>",
    );
  });

  it("prefers the text field when it has one", () => {
    const result = classifySlackEvent(envelope(mention({ blocks: richBlocks })), config);
    if (result._tag !== "message") throw new Error("expected a message");
    expect(result.event.text).toBe("fix the login bug");
  });

  it("bounds a hostile block payload", () => {
    const section = {
      type: "rich_text_section",
      elements: Array.from({ length: 50_000 }, () => ({ type: "text", text: "a" })),
    };
    const result = classifySlackEvent(
      envelope(mention({ text: "", blocks: [{ type: "rich_text", elements: [section] }] })),
      config,
    );
    if (result._tag !== "message") throw new Error("expected a message");
    expect(result.event.text.length).toBeLessThanOrEqual(2000);
  });

  it.each([
    ["own bot user", mention({ user: "U0000000002" }), "own_bot"],
    ["bot_id", mention({ bot_id: "B0OTHER" }), "bot_message"],
    ["bot_profile without bot_id", mention({ bot_profile: { id: "B0OTHER" } }), "bot_message"],
    ["bot_message subtype", directMessage({ subtype: "bot_message" }), "bot_message"],
    ["edited message", directMessage({ subtype: "message_changed" }), "subtype"],
    ["deleted message", directMessage({ subtype: "message_deleted" }), "subtype"],
    ["hidden message", directMessage({ hidden: true }), "hidden"],
    ["missing user", withoutUser(directMessage()), "missing_user"],
    [
      "plain channel message",
      directMessage({ channel_type: "channel", channel: "C0000000001" }),
      "channel_message",
    ],
    ["channel outside the allowlist", mention({ channel: "C0OTHER" }), "channel_not_allowed"],
    ["mention of only the bot", mention({ text: "<@U0000000002>" }), "empty"],
    ["non-numeric ts", mention({ ts: "later" }), "malformed"],
    ["bad thread_ts", mention({ thread_ts: "1760000000" }), "malformed"],
    ["lowercase channel ID", mention({ channel: "c0allowed" }), "malformed"],
    [
      "unsupported event type",
      { type: "reaction_added", user: "U0000000001" },
      "unsupported_event",
    ],
  ])("ignores %s", (_label, event, reason) => {
    expect(classifySlackEvent(envelope(event), config)).toEqual({ _tag: "ignored", reason });
  });

  it("rejects every channel mention when the allowlist is empty", () => {
    expect(
      classifySlackEvent(envelope(mention()), { ...config, allowedChannelIds: new Set() }),
    ).toEqual({ _tag: "ignored", reason: "channel_not_allowed" });
  });

  it("ignores events from another workspace and malformed envelopes", () => {
    expect(classifySlackEvent(envelope(mention(), { team_id: "T0OTHER" }), config)).toEqual({
      _tag: "ignored",
      reason: "team_mismatch",
    });
    expect(classifySlackEvent(envelope(mention(), { team_id: "" }), config)).toEqual({
      _tag: "ignored",
      reason: "malformed",
    });
    expect(classifySlackEvent({ type: "url_verification" }, config)).toEqual({
      _tag: "ignored",
      reason: "not_event_callback",
    });
    expect(classifySlackEvent(null, config)).toEqual({
      _tag: "ignored",
      reason: "not_event_callback",
    });
  });

  it("routes a DM link command with its code and keeps the code out of the text", () => {
    const result = classifySlackEvent(envelope(directMessage({ text: "link ABC123" })), config);
    expect(result).toMatchObject({ _tag: "link", code: "ABC123", event: { text: "" } });
  });

  it("asks for link help when a DM link command has no code", () => {
    expect(classifySlackEvent(envelope(directMessage({ text: "link" })), config)).toMatchObject({
      _tag: "link_notice",
      notice: "link_help",
      event: { text: "" },
    });
  });

  it("reports a DM link command with extra words as invalid and drops its words", () => {
    const result = classifySlackEvent(
      envelope(directMessage({ text: "link ABC123 extra" })),
      config,
    );
    expect(result).toMatchObject({ _tag: "link_notice", notice: "link_invalid" });
    expect(JSON.stringify(result)).not.toContain("ABC123");
  });

  it("drops a link code posted in a channel and asks for link help", () => {
    const result = classifySlackEvent(
      envelope(mention({ text: "<@U0000000002> link ABC123" })),
      config,
    );
    expect(result).toMatchObject({ _tag: "link_notice", notice: "link_help" });
    expect(JSON.stringify(result)).not.toContain("ABC123");
  });

  it("does not mistake words that start with link for the command", () => {
    const result = classifySlackEvent(
      envelope(directMessage({ text: "linking the repos" })),
      config,
    );
    expect(result).toMatchObject({ _tag: "message", event: { text: "linking the repos" } });
  });

  it("builds a gateway message that replies in the mention's thread", () => {
    const result = classifySlackEvent(
      envelope(mention({ ts: "1760000000.000300", thread_ts: "1760000000.000100" })),
      config,
    );
    if (result._tag !== "message") throw new Error("expected a message");
    expect(
      toSlackInboundMessage(result.event, {
        connectionId: "slack-0123456789ab",
        receivedAt: "2026-10-12T00:00:00.000Z",
      }),
    ).toEqual({
      kind: "slack",
      connectionId: "slack-0123456789ab",
      conversationKey: "T0000000001:C0000000001",
      externalMessageId: "1760000000.000300",
      idempotencyKey: "T0000000001:Ev0001AAAA",
      actor: { externalActorId: "U0000000001" },
      replyAddress: {
        kind: "slack",
        connectionId: "slack-0123456789ab",
        teamId: "T0000000001",
        channelId: "C0000000001",
        rootTs: "1760000000.000100",
      },
      text: "fix the login bug",
      receivedAt: "2026-10-12T00:00:00.000Z",
    });
  });
});

describe("revocation classification", () => {
  const config = {
    teamId: "T0000000001",
    botUserId: "U0000000002",
    allowedChannelIds: new Set<string>(),
  };
  it.each([
    [{ type: "tokens_revoked", tokens: { bot: ["U0000000002"] } }, "revocation"],
    [{ type: "tokens_revoked", tokens: { bot: ["U0OTHER"] } }, "ignored"],
    [{ type: "tokens_revoked", tokens: { oauth: ["U0000000002"] } }, "ignored"],
    [{ type: "app_uninstalled" }, "revocation"],
  ])("classifies only our bot revocation and keeps outer event_time: %j", (event, tag) => {
    const result = classifySlackEvent(envelope(event, { event_time: 1234 }), config);
    expect(result._tag).toBe(tag);
    if (result._tag === "revocation") expect(result.event.eventTime).toBe(1234);
    expect(
      classifySlackEvent(envelope(event, { team_id: "T0OTHER", event_time: 1234 }), config),
    ).toEqual({ _tag: "ignored", reason: "team_mismatch" });
  });
});

describe("classifySlackInteraction", () => {
  const press = (overrides: Record<string, unknown> = {}, channel = "C0000000001") => ({
    type: "block_actions",
    team: { id: "T0000000001" },
    user: { id: "U0000000001" },
    channel: { id: channel },
    message: { ts: "1760000000.000200", ...overrides },
    actions: [
      {
        action_id: "t3_choice_1",
        value: "approve:A1",
        text: { type: "plain_text", text: "Approve" },
        action_ts: "1760000001.000100",
      },
    ],
  });

  it("turns a button press into a message with the button's label and value", () => {
    const result = classifySlackInteraction(press({ thread_ts: "1760000000.000100" }), config);
    expect(result).toMatchObject({
      _tag: "message",
      event: {
        text: "Approve",
        choiceValue: "approve:A1",
        rootTs: "1760000000.000100",
        conversationKey: "T0000000001:C0000000001",
        dedupeKey:
          "T0000000001:ia:C0000000001:1760000000.000100:U0000000001:t3_choice_1:1760000001.000100",
      },
    });
    if (result._tag !== "message") throw new Error("expected a message");
    expect(
      toSlackInboundMessage(result.event, {
        connectionId: "slack-1",
        receivedAt: "2026-10-12T00:00:00.000Z",
      }).choiceValue,
    ).toBe("approve:A1");
  });

  it("answers a card in a channel in the card's own thread when it has none", () => {
    expect(classifySlackInteraction(press(), config)).toMatchObject({
      event: { rootTs: "1760000000.000200" },
    });
  });

  it("answers a card in a direct message top-level", () => {
    expect(classifySlackInteraction(press({}, "D0000000001"), config)).toMatchObject({
      _tag: "message",
      event: { rootTs: undefined, surface: "dm" },
    });
  });

  it("uses the value as the text when the button carries no label", () => {
    const body = press();
    delete (body.actions[0] as { text?: unknown }).text;
    expect(classifySlackInteraction(body, config)).toMatchObject({ event: { text: "approve:A1" } });
  });

  it.each([
    ["another workspace", { ...press(), team: { id: "T0OTHER" } }, "team_mismatch"],
    ["the bot itself", { ...press(), user: { id: "U0000000002" } }, "own_bot"],
    ["a channel outside the allowlist", press({}, "C0OTHER"), "channel_not_allowed"],
    [
      "an unknown button",
      { ...press(), actions: [{ action_id: "x", value: "v" }] },
      "unsupported_event",
    ],
    ["another payload type", { type: "shortcut" }, "unsupported_event"],
    [
      "a bad action timestamp",
      { ...press(), actions: [{ action_id: "t3_choice_1", value: "v", action_ts: "later" }] },
      "unsupported_event",
    ],
    ["a malformed channel", press({}, "bad id"), "malformed"],
  ])("ignores %s", (_label, body, reason) => {
    expect(classifySlackInteraction(body, config)).toEqual({ _tag: "ignored", reason });
  });

  it("ignores a channel card with no timestamp to reply under", () => {
    expect(classifySlackInteraction({ ...press(), message: {} }, config)).toEqual({
      _tag: "ignored",
      reason: "malformed",
    });
  });
});
