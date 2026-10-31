import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import type { ChannelInboundMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as AssistantService from "../assistants/AssistantService.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelBridge from "./ChannelBridge.ts";
import { ChannelGateway } from "./ChannelGateway.ts";
import { ChannelIdentities } from "./ChannelIdentities.ts";
import * as ChannelOutbox from "./ChannelOutbox.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import { channelAddress, dmAddress, inbound, outboxRows } from "./channelBridgeTestSupport.ts";

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

const harness = () => {
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
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(AssistantService.AssistantService)({
          list: Effect.suspend(() =>
            state.listFails ? Effect.fail({ reason: "storage" }) : Effect.succeed(state.assistants),
          ) as never,
          ensureDefault: Effect.sync(() => state.assistants[0]) as never,
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

const link = (actor = "U1") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR REPLACE INTO channel_identities (connection_id, external_actor_id, linked_at)
      VALUES ('c1', ${actor}, '2026-01-01T00:00:00.000Z')`;
  });

const texts = Effect.map(outboxRows, (rows) => rows.map((row) => row.message.text));

it.effect("an unlinked sender gets the link help and nothing reaches a thread", () => {
  const { layer, sends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const message = inbound();
    yield* gateway.ingest(message);
    yield* gateway.ingest(message);
    yield* gateway.ingest(inbound({ choiceValue: "decision:d1:accept" }));
    assert.lengthOf(sends, 0);
    const rows = yield* outboxRows;
    assert.lengthOf(rows, 2);
    assert.include(rows[0]!.message.text, "Settings → Slack → Link your account");
    assert.include(rows[0]!.message.text, "link <code>");
    assert.deepEqual(rows[0]!.message.destination, dmAddress);
  }).pipe(Effect.provide(layer));
});

it.effect("a duplicate inbound message is a no-op", () => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    yield* link();
    const message = inbound();
    yield* gateway.ingest(message);
    yield* gateway.ingest(message);
    assert.lengthOf(channelSends(), 1);
  }).pipe(Effect.provide(layer));
});

it.effect("a message reaches the current thread unchanged, queued, with a stable id", () => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const sql = yield* SqlClient.SqlClient;
    yield* link();
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
    assert.deepEqual([target!.assistant_id, target!.actor_id], ["jarvis", "U1"]);
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
  { name: "unknown @word is text", text: "@nobody hi", to: "jarvis", delivered: "@nobody hi" },
  {
    name: "name inside a longer word",
    text: "@researchers hi",
    to: "jarvis",
    delivered: "@researchers hi",
  },
  { name: "archived assistant", text: "@old hi", to: "jarvis", delivered: "@old hi" },
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
    yield* link();
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
    yield* link();
    yield* gateway.ingest(inbound({ text: "@research first" }));
    yield* gateway.ingest(inbound({ text: "second" }));
    yield* gateway.ingest(
      inbound({ text: "elsewhere", conversationKey: "slack:T1:C1", replyAddress: channelAddress }),
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
    yield* link();
    yield* gateway.ingest(inbound({ text: "@research" }));
    yield* gateway.ingest(inbound({ text: "now" }));
    assert.deepEqual(yield* texts, ["You are now talking to Research."]);
    assert.equal(channelSends()[0]!.threadId, "assistant:research:1");
  }).pipe(Effect.provide(layer));
});

it.effect("a message that cannot be delivered gets a failure line", () => {
  const { layer, state, sends } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const sql = yield* SqlClient.SqlClient;
    yield* link();
    state.sendFailure = { message: "Thread is archived." };
    yield* gateway.ingest(inbound());
    yield* gateway.ingest(inbound({ text: "@fresh hi" }));
    state.listFails = true;
    yield* gateway.ingest(inbound());
    assert.lengthOf(sends, 1);
    assert.deepEqual(yield* texts, [
      "I could not pass that on to Jarvis: Thread is archived.",
      "I could not pass that on to Fresh: its conversation has not started yet",
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
    yield* link();
    yield* sql`DROP TABLE channel_inbox`;
    const error = yield* Effect.flip(gateway.ingest(inbound()));
    assert.equal(error.reason, "persistence_failed");
    yield* sql`DROP TABLE channel_identities`;
    assert.equal((yield* Effect.flip(gateway.ingest(inbound()))).reason, "persistence_failed");
    assert.equal(
      (yield* Effect.flip(
        gateway.linkIdentity({
          connectionId: "c1",
          externalActorId: "U1",
          code: "123456",
          idempotencyKey: "k",
          replyAddress: dmAddress,
        }),
      )).reason,
      "persistence_failed",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("rows stored but not sent are processed once at startup", () => {
  const { layer, channelSends } = harness();
  return Effect.gen(function* () {
    const bridge = yield* ChannelBridge.ChannelBridge;
    const sql = yield* SqlClient.SqlClient;
    yield* link();
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

it.effect("a link code links once, expires, and only its hash is stored", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const identities = yield* ChannelIdentities;
    const sql = yield* SqlClient.SqlClient;
    const consume = (code: string, key: string, actor = "U1") =>
      gateway.linkIdentity({
        connectionId: "c1",
        externalActorId: actor,
        code,
        idempotencyKey: key,
        replyAddress: dmAddress,
      });

    const first = yield* identities.createLinkCode("c1");
    assert.match(first.code, /^\d{6}$/);
    const stored = yield* sql<{
      readonly code_hash: string;
    }>`SELECT code_hash FROM channel_link_codes`;
    assert.notInclude(stored[0]!.code_hash, first.code);

    yield* consume("000000x", "wrong");
    yield* consume(first.code, "ok");
    yield* consume(first.code, "ok");
    yield* consume(first.code, "reuse", "U2");
    assert.deepEqual(
      (yield* identities.list("c1")).map((identity) => identity.externalActorId),
      ["U1"],
    );

    const second = yield* identities.createLinkCode("c1");
    yield* TestClock.adjust("11 minutes");
    yield* consume(second.code, "late");
    const rows = yield* outboxRows;
    assert.deepEqual(
      rows.map((row) => row.message.text.split(".")[0]),
      [
        "That link code did not work",
        "Linked",
        "That link code did not work",
        "That link code did not work",
      ],
    );
    assert.lengthOf(yield* identities.list("c1"), 1);

    yield* identities.createLinkCode("c1");
    const live = yield* sql`SELECT * FROM channel_link_codes`;
    assert.lengthOf(live, 1);
    assert.equal(
      (yield* Effect.flip(identities.unlink({ connectionId: "c1", externalActorId: "U9" }))).reason,
      "not_found",
    );
    yield* identities.unlink({ connectionId: "c1", externalActorId: "U1" });
    assert.lengthOf(yield* identities.list("c1"), 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a code made for one connection does not link another", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const identities = yield* ChannelIdentities;
    const { code } = yield* identities.createLinkCode("other");
    yield* gateway.linkIdentity({
      connectionId: "c1",
      externalActorId: "U1",
      code,
      idempotencyKey: "k",
      replyAddress: dmAddress,
    });
    assert.lengthOf(yield* identities.list("c1"), 0);
    assert.lengthOf(yield* identities.list("other"), 0);
  }).pipe(Effect.provide(layer));
});

it.effect("fixed notices are answered once per key", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const input = {
      connectionId: "c1",
      idempotencyKey: "n1",
      replyAddress: dmAddress,
      actor: { externalActorId: "U1" },
    };
    yield* gateway.requestNotice({ ...input, notice: "link_help" });
    yield* gateway.requestNotice({ ...input, notice: "link_help" });
    yield* gateway.requestNotice({ ...input, idempotencyKey: "n2", notice: "link_invalid" });
    assert.deepEqual(
      (yield* texts).map((text) => text.slice(0, 20)),
      ["To talk to your assi", "That link code did n"],
    );
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

it.effect("a button press answers the decision once; a stale press is told so", () => {
  const { layer, request } = decisionHarness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    const decisions = yield* DecisionService.DecisionService;
    yield* link();
    const decision = yield* request;
    const press = inbound({ choiceValue: `decision:${decision.id}:yes` });
    yield* gateway.ingest(press);
    yield* gateway.ingest(press);
    const answered = yield* decisions.get(decision.id);
    assert.deepEqual([answered.status, answered.answer?.optionId], ["answered", "yes"]);
    assert.lengthOf(yield* outboxRows, 0);

    yield* gateway.ingest(inbound({ choiceValue: `decision:${decision.id}:no` }));
    yield* gateway.ingest(inbound({ choiceValue: `decision:missing:no` }));
    yield* gateway.ingest(inbound({ choiceValue: `decision:${decision.id}` }));
    assert.deepEqual(yield* texts, [
      "That decision was already answered.",
      "That decision was already answered.",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("a button for an option the decision does not have is refused with a retry hint", () => {
  const { layer, request } = decisionHarness();
  return Effect.gen(function* () {
    const gateway = yield* ChannelGateway;
    yield* link();
    const decision = yield* request;
    yield* gateway.ingest(inbound({ choiceValue: `decision:${decision.id}:maybe` }));
    assert.deepEqual(yield* texts, ["I could not record that answer. Please try again."]);
  }).pipe(Effect.provide(layer));
});
