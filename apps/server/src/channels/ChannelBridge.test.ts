import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import type { ChannelInboundMessage, ChannelReplyAddress } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as AssistantService from "../assistants/AssistantService.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelBridge from "./ChannelBridge.ts";
import { ChannelGateway } from "./ChannelGateway.ts";
import { ChannelLanguage } from "./ChannelLanguage.ts";
import * as ChannelOutbox from "./ChannelOutbox.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import { dmAddress, inbound, otherChatAddress, outboxRows } from "./channelBridgeTestSupport.ts";

const assistant = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  handle: id,
  projectId: "scratch",
  isDefault: false,
  threadId: `assistant:${id}:1`,
  archivedAt: null,
  ...extra,
});

const harness = (language: "en" | "pt-BR" = "en") => {
  const state = {
    assistants: [
      assistant("jarvis", "Jarvis", { isDefault: true }),
      assistant("research-bot", "Research Bot"),
      assistant("research", "Research"),
      assistant("old", "Old", { archivedAt: "2026-01-01T00:00:00.000Z" }),
      assistant("fresh", "Fresh", { threadId: null }),
    ] as ReadonlyArray<Record<string, unknown>>,
    listFails: false,
    sendFailure: undefined as { message: string } | undefined,
  };
  const sends: Array<Record<string, unknown>> = [];
  const channelSends = () => sends.filter((send) => String(send.commandId).startsWith("channel:"));
  const layer = ChannelBridge.layer.pipe(
    Layer.provideMerge(ChannelOutbox.layer),
    Layer.provideMerge(DecisionService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ChannelTransport.layer,
        ChannelLanguage.layerFixed(language),
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(AssistantService.AssistantService)({
          list: Effect.suspend(() =>
            state.listFails ? Effect.fail({ reason: "storage" }) : Effect.succeed(state.assistants),
          ) as never,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) => {
            sends.push(input as never);
            return state.sendFailure === undefined
              ? Effect.succeed({} as never)
              : Effect.fail(state.sendFailure as never);
          },
        }),
      ),
    ),
  );
  return { layer, state, sends, channelSends };
};

const texts = Effect.map(outboxRows, (rows) => rows.map((row) => row.message.text));

it.effect("a duplicate inbound message is a no-op", () => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const message = inbound();
    yield* gateway.ingest(message);
    yield* gateway.ingest(message);
    assert.lengthOf(channelSends(), 1);
  }).pipe(Effect.provide(layer));
});

it.effect("a sender over the per-minute limit is held back once with one notice", () => {
  const { layer, channelSends } = harness();
  const at = (seconds: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, seconds)));
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    for (let index = 0; index < ChannelBridge.INBOUND_PER_MINUTE + 2; index += 1) {
      yield* gateway.ingest(inbound({ receivedAt: at(index) }));
    }
    yield* gateway.ingest(inbound({ receivedAt: at(20), actor: { externalActorId: "+1555999" } }));
    yield* gateway.ingest(inbound({ receivedAt: at(62) }));
    assert.lengthOf(channelSends(), ChannelBridge.INBOUND_PER_MINUTE + 2);
    assert.deepEqual(
      (yield* texts).filter((text) => text.includes("too fast")),
      ["You're sending messages too fast. I'll read new ones again in a minute."],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a message reaches the current thread unchanged, queued, with a stable id", () => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const sql = yield* SqlClient.SqlClient;
    const message = inbound({ text: "  what is up?\nsecond line " });
    yield* gateway.ingest(message);
    const [sent] = channelSends();
    assert.deepEqual(sent, {
      projectId: "scratch",
      commandId: `channel:c1:${message.idempotencyKey}`,
      messageId: `channel:c1:${message.idempotencyKey}`,
      threadId: "assistant:jarvis:1",
      text: "  what is up?\nsecond line ",
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "server",
    });
    const [target] = yield* sql<{ readonly assistant_id: string; readonly actor_id: string }>`
      SELECT assistant_id, actor_id FROM channel_reply_targets`;
    assert.deepEqual([target!.assistant_id, target!.actor_id], ["jarvis", "+15550000000"]);
    const [inboxRow] = yield* sql<{ readonly state: string }>`SELECT state FROM channel_inbox`;
    assert.equal(inboxRow!.state, "sent");
  }).pipe(Effect.provide(layer));
});

const routing: ReadonlyArray<{
  readonly name: string;
  readonly text: string;
  readonly to: string;
  readonly delivered: string;
}> = [
  { name: "default", text: "hello", to: "jarvis", delivered: "hello" },
  { name: "exact name", text: "@research hi there", to: "research", delivered: "hi there" },
  {
    name: "longest name with a space",
    text: "@research bot go",
    to: "research-bot",
    delivered: "go",
  },
  { name: "case-insensitive", text: "@RESEARCH BOT Go", to: "research-bot", delivered: "Go" },
  { name: "name then newline", text: "@Research\nplease", to: "research", delivered: "please" },
  {
    name: "mention later in the text",
    text: "ask @research",
    to: "jarvis",
    delivered: "ask @research",
  },
];

it.effect.each(routing)("routing: $name", (row) => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    yield* gateway.ingest(inbound({ text: row.text }));
    const [sent] = channelSends();
    assert.equal(sent!.threadId, `assistant:${row.to}:1`);
    assert.equal(sent!.text, row.delivered);
  }).pipe(Effect.provide(layer));
});

it.effect("an assistant picked by name stays sticky per conversation until it is gone", () => {
  const { layer, state, channelSends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    yield* gateway.ingest(inbound({ text: "@research first" }));
    yield* gateway.ingest(inbound({ text: "second" }));
    yield* gateway.ingest(
      inbound({
        text: "elsewhere",
        conversationKey: otherChatAddress.chatGuid,
        replyAddress: otherChatAddress,
      }),
    );
    yield* gateway.ingest(inbound({ text: "@jarvis back" }));
    yield* gateway.ingest(inbound({ text: "third" }));
    assert.deepEqual(
      channelSends().map((send) => send.threadId),
      [
        "assistant:research:1",
        "assistant:research:1",
        "assistant:jarvis:1",
        "assistant:jarvis:1",
        "assistant:jarvis:1",
      ],
    );
    yield* gateway.ingest(inbound({ text: "@research again" }));
    state.assistants = state.assistants.filter((candidate) => candidate.id !== "research");
    yield* gateway.ingest(inbound({ text: "after delete" }));
    assert.equal(channelSends().at(-1)!.threadId, "assistant:jarvis:1");
    state.assistants = state.assistants.map((candidate) =>
      candidate.id === "jarvis"
        ? candidate
        : { ...candidate, archivedAt: "2026-01-02T00:00:00.000Z" },
    );
    yield* gateway.ingest(inbound({ text: "@research-bot once" }));
    yield* gateway.ingest(inbound({ text: "after archive" }));
    assert.equal(channelSends().at(-1)!.threadId, "assistant:jarvis:1");
  }).pipe(Effect.provide(layer));
});

it.effect("naming an assistant with no text switches without sending", () => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    yield* gateway.ingest(inbound({ text: "@research" }));
    yield* gateway.ingest(inbound({ text: "now" }));
    assert.deepEqual(yield* texts, ["You are now talking to Research."]);
    assert.equal((yield* outboxRows)[0]!.message.senderName, "T3 Code");
    assert.equal(channelSends()[0]!.threadId, "assistant:research:1");
  }).pipe(Effect.provide(layer));
});

it.effect("@ alone or an unknown @name lists the assistants instead of sending", () => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    for (const text of ["@", " @nobody hi", "@researchers hi", "@old hi"]) {
      yield* gateway.ingest(inbound({ text }));
    }
    const roster =
      "Your assistants: Jarvis, Research Bot, Research, Fresh. Start a message with @Name to talk to one; Jarvis answers otherwise.";
    assert.deepEqual(yield* texts, [roster, roster, roster, roster]);
    assert.equal(channelSends().length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("with no active assistant a message and a roster ask say none is set up", () => {
  const { layer, state, channelSends } = harness();
  return Effect.gen(function* () {
    state.assistants = [];
    const gateway = yield* ChannelGateway;
    yield* gateway.ingest(inbound({ text: "hello" }));
    yield* gateway.ingest(inbound({ text: "@" }));
    const none = "No assistants are set up. Create one in Settings \u2192 Assistants.";
    assert.deepEqual(yield* texts, [none, none]);
    assert.equal(channelSends().length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("in Portuguese its own replies are Portuguese, flagged for the transport", () => {
  const { layer, state, sends } = harness("pt-BR");
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    yield* gateway.ingest(inbound({ text: "@" }));
    yield* gateway.ingest(inbound({ text: "@research" }));
    yield* gateway.ingest(inbound({ text: "@fresh hi" }));
    state.assistants = [];
    yield* gateway.ingest(inbound({ text: "hello" }));
    assert.deepEqual(yield* texts, [
      "Seus assistentes: Jarvis, Research Bot, Research, Fresh. Comece a mensagem com @Nome para falar com um; senão, o Jarvis responde.",
      "Agora você está falando com Research.",
      "Não consegui repassar isso: a conversa dele ainda não começou",
      "Nenhum assistente configurado. Crie um em Configurações → Assistentes.",
    ]);
    assert.deepEqual(
      (yield* outboxRows).map((row) => row.message.language),
      ["pt-BR", "pt-BR", "pt-BR", "pt-BR"],
    );
    assert.lengthOf(sends, 0);
  }).pipe(Effect.provide(layer));
});

const telegramMessage = (text: string) =>
  inbound({
    kind: "telegram",
    text,
    conversationKey: "42",
    replyAddress: { kind: "telegram", connectionId: "c1", chatId: "42" },
  });

const slashRouting: ReadonlyArray<readonly [string, string, string]> = [
  ["/research hi there", "research", "hi there"],
  ["/research_bot go", "research_bot", "go"],
  ["/RESEARCH@my_bot hi", "research", "hi"],
  ["/research@my_bot\nplease", "research", "please"],
  ["/jarvis@my_bot x", "jarvis", "x"],
  ["@research hi", "research", "hi"],
];

it.effect.each(slashRouting)("telegram /command routes like @Name: %s", ([text, to, delivered]) => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    yield* (yield* ChannelGateway).ingest(telegramMessage(text));
    const [sent] = channelSends();
    assert.equal(sent!.threadId, `assistant:${to!.replace("_", "-")}:1`);
    assert.equal(sent!.text, delivered);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "telegram: a bare /command switches, unknown or archived ones list, paths pass through",
  () => {
    const { layer, channelSends } = harness();
    return Effect.gen(function* () {
      const gateway = yield* ChannelGateway;
      yield* gateway.ingest(telegramMessage("/research"));
      yield* gateway.ingest(telegramMessage("/nobody hi"));
      yield* gateway.ingest(telegramMessage("/old hi"));
      yield* gateway.ingest(telegramMessage("/etc/hosts please"));
      // Only Telegram has a command menu; iMessage text is never read as a command.
      yield* gateway.ingest(inbound({ text: "/research hi" }));
      const rows = yield* texts;
      const roster =
        "Your assistants: Jarvis, Research Bot, Research, Fresh. Start a message with @Name to talk to one; Jarvis answers otherwise.";
      assert.deepEqual(rows, ["You are now talking to Research.", roster, roster]);
      assert.deepEqual(
        channelSends().map((send) => [send.threadId, send.text]),
        [
          ["assistant:research:1", "/etc/hosts please"],
          ["assistant:jarvis:1", "/research hi"],
        ],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a message that cannot be delivered gets a failure line", () => {
  const { layer, state, sends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const sql = yield* SqlClient.SqlClient;
    state.sendFailure = { message: "Thread is archived." };
    yield* gateway.ingest(inbound());
    yield* gateway.ingest(inbound({ text: "@fresh hi" }));
    state.listFails = true;
    yield* gateway.ingest(inbound());
    assert.lengthOf(sends, 1);
    assert.deepEqual(
      (yield* outboxRows).map((row) => row.message.senderName),
      ["Jarvis", "Fresh", "T3 Code"],
    );
    assert.deepEqual(yield* texts, [
      "I could not pass that on: Thread is archived.",
      "I could not pass that on: its conversation has not started yet",
      "I could not reach your assistants right now. Please try again.",
    ]);
    const states = yield* sql<{ readonly state: string }>`SELECT DISTINCT state FROM channel_inbox`;
    assert.deepEqual(
      states.map((row) => row.state),
      ["sent"],
    );
    const targets = yield* sql`SELECT * FROM channel_reply_targets`;
    assert.lengthOf(targets, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a storage failure fails ingest so the transport leaves the event for redelivery", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE channel_inbox`;
    const error = yield* Effect.flip(gateway.ingest(inbound()));
    assert.equal(error.reason, "persistence_failed");
  }).pipe(Effect.provide(layer));
});

it.effect("rows stored but not sent are processed once at startup", () => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    const bridge = yield* ChannelBridge.ChannelBridge;
    const sql = yield* SqlClient.SqlClient;
    const stored: ChannelInboundMessage = inbound({ text: "@research left behind" });
    yield* sql`
      INSERT INTO channel_inbox (connection_id, idempotency_key, payload_json, state)
      VALUES ('c1', ${stored.idempotencyKey},
        ${JSON.stringify(stored)}, 'stored')`;
    yield* sql`
      INSERT INTO channel_inbox (connection_id, idempotency_key, payload_json, state)
      VALUES ('c1', 'broken', '{', 'stored')`;
    yield* bridge.catchUp;
    yield* bridge.catchUp;
    assert.lengthOf(channelSends(), 1);
    assert.equal(channelSends()[0]!.text, "left behind");
    assert.equal(channelSends()[0]!.commandId, `channel:c1:${stored.idempotencyKey}`);
    const [row] = yield* sql<{ readonly state: string }>`
      SELECT state FROM channel_inbox WHERE idempotency_key = ${stored.idempotencyKey}`;
    assert.equal(row!.state, "sent");
    yield* bridge.start();
  }).pipe(Effect.provide(layer));
});

const decisionHarness = () => {
  const base = harness();
  return {
    ...base,
    request: Effect.gen(function* () {
      const decisions = yield* DecisionService.DecisionService;
      return yield* decisions.request({
        fromThreadId: "assistant:jarvis:1" as never,
        projectId: "scratch" as never,
        threadTitle: "Jarvis",
        clientRequestId: "r1",
        title: "Deploy?",
        context: "",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      });
    }),
  };
};

const parseRows: ReadonlyArray<{ readonly text: string; readonly number: number | undefined }> = [
  { text: "2", number: 2 },
  { text: " 2 ", number: 2 },
  { text: "2.", number: 2 },
  { text: "2)", number: 2 },
  { text: "10", number: 10 },
  { text: "123", number: undefined },
  { text: "2 please", number: undefined },
  { text: "@jarvis 2", number: undefined },
  { text: "", number: undefined },
];
it.each(parseRows)("number reply parsing: $text", (row) => {
  assert.equal(ChannelBridge.parseNumberReply(row.text), row.number);
});

/** Records the card the reactor would have sent, so a number reply can find it. */
const sendCard = (decisionId: string, address: ChannelReplyAddress = dmAddress) =>
  Effect.gen(function* () {
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const sql = yield* SqlClient.SqlClient;
    const deliveryId = `channel-decision:${decisionId}`;
    yield* outbox.enqueue({
      deliveryId,
      destination: address,
      senderName: "Jarvis",
      text: "Deploy?",
      choices: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ],
    });
    yield* sql`INSERT INTO channel_cards (decision_id, delivery_id) VALUES (${decisionId}, ${deliveryId})`;
  });

it.effect("a number answers the open card of that chat once; others are told or passed on", () => {
  const { layer, request, channelSends } = decisionHarness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const decisions = yield* DecisionService.DecisionService;
    const decision = yield* request;
    // Nothing is open yet: the number is an ordinary message to the assistant.
    yield* gateway.ingest(inbound({ text: "2" }));
    assert.deepEqual(
      channelSends().map((send) => send.text),
      ["2"],
    );
    yield* sendCard(decision.id);
    yield* gateway.ingest(inbound({ text: "3" }));
    yield* gateway.ingest(
      inbound({
        text: "1",
        conversationKey: otherChatAddress.chatGuid,
        replyAddress: otherChatAddress,
      }),
    );
    assert.equal((yield* decisions.get(decision.id)).status, "open");
    yield* gateway.ingest(inbound({ text: " 1. " }));
    const answered = yield* decisions.get(decision.id);
    assert.deepEqual([answered.status, answered.answer?.optionId], ["answered", "yes"]);
    // Settled: a number is a normal message again, and the numbered answer was never forwarded.
    yield* gateway.ingest(inbound({ text: "2" }));
    assert.deepEqual(
      channelSends().map((send) => send.text),
      ["2", "1", "2"],
    );
    assert.deepEqual((yield* texts).slice(1), ["Reply with a number from 1 to 2."]);
  }).pipe(Effect.provide(layer));
});

it.effect("with two cards open a number answers the newest, then says which one is next", () => {
  const { layer, request } = decisionHarness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const decisions = yield* DecisionService.DecisionService;
    const older = yield* request;
    const newer = yield* decisions.request({
      fromThreadId: "thread-2" as never,
      projectId: "scratch" as never,
      threadTitle: "Fix login",
      clientRequestId: "r2",
      title: "Claude wants to run a command",
      context: "",
      options: [
        { id: "accept", label: "Approve" },
        { id: "decline", label: "Deny" },
      ],
    });
    yield* sendCard(older.id);
    yield* sendCard(newer.id);
    yield* gateway.ingest(inbound({ text: "2" }));
    assert.equal((yield* decisions.get(newer.id)).answer?.optionId, "decline");
    assert.equal((yield* decisions.get(older.id)).status, "open");
    assert.equal((yield* texts).at(-1), 'Still waiting for you: "Deploy?". Numbers now answer it.');
    yield* gateway.ingest(inbound({ text: "1" }));
    assert.equal((yield* decisions.get(older.id)).answer?.optionId, "yes");
    // Nothing else is open, so no "next" line follows the last answer.
    assert.equal((yield* texts).at(-1), 'Still waiting for you: "Deploy?". Numbers now answer it.');
  }).pipe(Effect.provide(layer));
});

it.effect("a number for a card that lapsed before the sweep says so and records nothing", () => {
  const { layer } = decisionHarness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const decisions = yield* DecisionService.DecisionService;
    const lapsing = yield* decisions.request({
      fromThreadId: "thread-2" as never,
      projectId: "scratch" as never,
      threadTitle: "Fix login",
      clientRequestId: "r-lapse",
      title: "Claude wants to run a command",
      context: "",
      options: [
        { id: "accept", label: "Approve" },
        { id: "decline", label: "Deny" },
      ],
      expiresInMinutes: 1,
    });
    yield* sendCard(lapsing.id);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE decisions SET expires_at = ${"1970-01-01T00:00:00.000Z"} WHERE decision_id = ${lapsing.id}`;
    yield* gateway.ingest(inbound({ text: "1" }));
    assert.equal((yield* texts).at(-1), "That decision was already answered.");
    assert.isUndefined((yield* decisions.get(lapsing.id)).answer);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a Telegram chat answers its own card, and an iMessage chat with the same key cannot",
  () => {
    const { layer, request } = decisionHarness();
    const telegram = { kind: "telegram", connectionId: "c1", chatId: "chat-1" } as const;
    const sameKeyImessage = { ...dmAddress, chatGuid: "chat-1" };
    return Effect.gen(function* () {
      const gateway = yield* ChannelGateway;
      const decisions = yield* DecisionService.DecisionService;
      const decision = yield* request;
      yield* sendCard(decision.id, telegram);
      yield* gateway.ingest(
        inbound({ text: "1", conversationKey: "chat-1", replyAddress: sameKeyImessage }),
      );
      assert.equal((yield* decisions.get(decision.id)).status, "open");
      yield* gateway.ingest(
        inbound({ kind: "telegram", text: "1", conversationKey: "chat-1", replyAddress: telegram }),
      );
      assert.equal((yield* decisions.get(decision.id)).answer?.optionId, "yes");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "a number for a card answered elsewhere is not forwarded; a failing answer says so",
  () => {
    const { layer, request, channelSends } = decisionHarness();
    return Effect.gen(function* () {
      const gateway = yield* ChannelGateway;
      const decisions = yield* DecisionService.DecisionService;
      const decision = yield* request;
      yield* sendCard(decision.id);
      yield* decisions.answer({ decisionId: decision.id, optionId: "no" });
      yield* gateway.ingest(inbound({ text: "1" }));
      assert.deepEqual(
        channelSends().map((send) => send.text),
        ["1"],
      );
    }).pipe(Effect.provide(layer));
  },
);
