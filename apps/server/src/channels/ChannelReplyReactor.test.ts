import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import type { Decision, DecisionError, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as DecisionService from "../decisions/DecisionService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ChannelLanguage } from "./ChannelLanguage.ts";
import * as ChannelOutbox from "./ChannelOutbox.ts";
import * as Reactor from "./ChannelReplyReactor.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import { encodeReplyAddress } from "./ChannelBridge.ts";
import {
  dmAddress,
  fakeTransport,
  otherChatAddress,
  outboxRows,
} from "./channelBridgeTestSupport.ts";

const thread = "assistant:jarvis:2";

interface Records {
  messages: Array<{ text: string }>;
  turnItems: Array<{ type: string; failure?: { message: string } }>;
}

const harness = (language: "en" | "pt-BR" = "en") => {
  const records = new Map<string, Records>();
  const reads: string[] = [];
  const layer = Reactor.layer.pipe(
    Layer.provideMerge(ChannelOutbox.layer),
    Layer.provideMerge(DecisionService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ChannelTransport.layer,
        ChannelLanguage.layerFixed(language),
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: () => Effect.succeed({} as never),
          getThreadRecords: (_threadId, _kinds, filter) => {
            const runId = filter?.messageRunIds?.[0] ?? "";
            reads.push(runId);
            return Effect.succeed((records.get(runId) ?? { messages: [], turnItems: [] }) as never);
          },
        }),
      ),
    ),
  );
  return { layer, records, reads };
};

const speak = (
  address: typeof dmAddress | typeof otherChatAddress = dmAddress,
  assistant = "jarvis",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (assistant === "jarvis") {
      yield* sql`
        INSERT OR IGNORE INTO assistants
          (assistant_id, handle, name, project_id, tool_access, created_at, updated_at)
        VALUES ('jarvis', 'jarvis', 'Jarvis', 'scratch', 'full', '2026-01-01', '2026-01-01')`;
    }
    yield* sql`
      INSERT OR REPLACE INTO channel_reply_targets (assistant_id, address_json, actor_id)
      VALUES (${assistant}, ${encodeReplyAddress(address)}, '+15550000000')`;
  });

const runEvent = (status: string, id = "run-1", threadId = thread) =>
  ({
    type: "run.updated",
    threadId,
    payload: { id, threadId, status },
  }) as unknown as OrchestrationV2DomainEvent;

const messageEvent = (patch: Record<string, unknown>) =>
  ({
    type: "message.updated",
    threadId: thread,
    payload: {
      threadId: thread,
      role: "user",
      createdBy: "user",
      creationSource: "web",
      ...patch,
    },
  }) as unknown as OrchestrationV2DomainEvent;

it.effect("a finished run posts its last assistant message once, however often it replays", () => {
  const { layer, records, reads } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    yield* speak();
    records.set("run-1", {
      messages: [{ text: "working on it" }, { text: "Here you go." }, { text: "  " }],
      turnItems: [],
    });
    for (const status of ["running", "completed", "completed"]) {
      yield* reactor.handle(runEvent(status));
    }
    const rows = yield* outboxRows;
    assert.lengthOf(rows, 1);
    assert.deepEqual(rows[0]!.message, {
      deliveryId: "channel-run:run-1",
      destination: dmAddress,
      text: "Here you go.",
      senderName: "Jarvis",
      markdown: true,
      language: "en",
    });
    assert.lengthOf(reads, 1);
  }).pipe(Effect.provide(layer));
});

const outcomes: ReadonlyArray<{
  readonly name: string;
  readonly status: string;
  readonly records: Records;
  readonly text: string | undefined;
}> = [
  {
    name: "failed with the error text",
    status: "failed",
    records: {
      messages: [],
      turnItems: [{ type: "error", failure: { message: "Budget reached" } }],
    },
    text: "I could not finish that: Budget reached",
  },
  {
    name: "failed without an error item",
    status: "failed",
    records: { messages: [], turnItems: [] },
    text: "I could not finish that.",
  },
  {
    name: "failed but with a reply",
    status: "failed",
    records: { messages: [{ text: "Partial answer" }], turnItems: [] },
    text: "Partial answer",
  },
  {
    name: "completed without text",
    status: "completed",
    records: { messages: [], turnItems: [] },
    text: undefined,
  },
  {
    name: "cancelled without text",
    status: "cancelled",
    records: { messages: [], turnItems: [] },
    text: undefined,
  },
  {
    name: "interrupted with text",
    status: "interrupted",
    records: { messages: [{ text: "Stopped here" }], turnItems: [] },
    text: "Stopped here",
  },
  {
    name: "still running",
    status: "running",
    records: { messages: [{ text: "x" }], turnItems: [] },
    text: undefined,
  },
];

it.effect.each(outcomes)("a run that is $name", (outcome) => {
  const { layer, records } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    yield* speak();
    records.set("run-1", outcome.records);
    yield* reactor.handle(runEvent(outcome.status));
    assert.deepEqual(
      (yield* outboxRows).map((row) => row.message.text),
      outcome.text === undefined ? [] : [outcome.text],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a reply goes to the chat that was last spoken in, in the assistant's name", () => {
  const { layer, records } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    records.set("run-1", { messages: [{ text: "hi" }], turnItems: [] });
    records.set("run-2", { messages: [{ text: "hi" }], turnItems: [] });
    yield* speak(otherChatAddress);
    yield* reactor.handle(runEvent("completed", "run-1"));
    yield* speak(dmAddress);
    yield* reactor.handle(runEvent("completed", "run-2"));
    const [first, second] = yield* outboxRows;
    assert.deepEqual(
      [first!.message.destination, first!.message.senderName, second!.message.destination],
      [otherChatAddress, "Jarvis", dmAddress],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("runs of other threads, or with nobody to answer, post nothing", () => {
  const { layer, records, reads } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    records.set("run-1", { messages: [{ text: "hi" }], turnItems: [] });
    yield* reactor.handle(runEvent("completed"));
    yield* speak(dmAddress, "someone-else");
    yield* reactor.handle(runEvent("completed"));
    yield* speak();
    yield* reactor.handle(runEvent("completed", "run-1", "plain-thread"));
    assert.lengthOf(yield* outboxRows, 0);
    assert.lengthOf(reads, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a message from the app stops replies going to the chat; other sources do not", () => {
  const { layer, records } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    const sql = yield* SqlClient.SqlClient;
    const targets = () => sql`SELECT * FROM channel_reply_targets`;
    yield* speak();
    for (const patch of [
      { creationSource: "server" },
      { creationSource: "mcp" },
      { creationSource: "provider" },
      { role: "assistant" },
      { createdBy: "agent" },
    ]) {
      yield* reactor.handle(messageEvent(patch));
      assert.lengthOf(yield* targets(), 1);
    }
    yield* reactor.handle(messageEvent({ threadId: "plain-thread" }));
    assert.lengthOf(yield* targets(), 1);

    yield* reactor.handle(messageEvent({ creationSource: "mobile" }));
    assert.lengthOf(yield* targets(), 0);
    yield* speak();
    yield* reactor.handle(messageEvent({ creationSource: "web", threadId: "assistant:jarvis:1" }));
    assert.lengthOf(yield* targets(), 0);

    records.set("run-1", { messages: [{ text: "hi" }], turnItems: [] });
    yield* reactor.handle(runEvent("completed"));
    assert.lengthOf(yield* outboxRows, 0);
  }).pipe(Effect.provide(layer));
});

const openDecision = Effect.gen(function* () {
  const decisions = yield* DecisionService.DecisionService;
  return yield* decisions.request({
    fromThreadId: thread as never,
    projectId: "scratch" as never,
    threadTitle: "Jarvis",
    clientRequestId: "r1",
    title: "Deploy?",
    context: "To production",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    expiresInMinutes: 5,
  });
});

it.effect("an open decision becomes a card with its options, posted once", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    const decision = yield* openDecision;
    yield* reactor.handleDecision(decision);
    assert.lengthOf(yield* outboxRows, 0);

    yield* speak(otherChatAddress);
    yield* reactor.handleDecision(decision);
    yield* reactor.handleDecision(decision);
    const rows = yield* outboxRows;
    assert.lengthOf(rows, 1);
    assert.deepEqual(rows[0]!.message, {
      deliveryId: `channel-decision:${decision.id}`,
      destination: otherChatAddress,
      senderName: "Jarvis",
      text: "Deploy?\n\nTo production",
      choices: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ],
      language: "en",
    });
  }).pipe(Effect.provide(layer));
});

const settlements: ReadonlyArray<{
  readonly name: string;
  readonly settle: (
    decision: Decision,
  ) => Effect.Effect<unknown, DecisionError, DecisionService.DecisionService>;
  readonly line: string;
}> = [
  {
    name: "answered in the app",
    settle: (decision) =>
      Effect.flatMap(Effect.service(DecisionService.DecisionService), (service) =>
        service.answer({ decisionId: decision.id, optionId: "yes" }),
      ),
    line: "Answered: Yes",
  },
  {
    name: "answered with free text",
    settle: (decision) =>
      Effect.flatMap(Effect.service(DecisionService.DecisionService), (service) =>
        service.answer({ decisionId: decision.id, text: "later" }),
      ),
    line: "Answered: later",
  },
  {
    name: "withdrawn",
    settle: (decision) =>
      Effect.flatMap(Effect.service(DecisionService.DecisionService), (service) =>
        service.withdraw({ decisionId: decision.id, fromThreadId: decision.fromThreadId }),
      ),
    line: "Withdrawn",
  },
  {
    name: "expired",
    settle: () =>
      Effect.flatMap(Effect.service(DecisionService.DecisionService), (service) =>
        TestClock.adjust("6 minutes").pipe(Effect.andThen(service.expireDue)),
      ),
    line: "Expired",
  },
];

it.effect.each(settlements)(
  "one line follows the card once its decision is $name",
  (settlement) => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const reactor = yield* Reactor.ChannelReplyReactor;
      const outbox = yield* ChannelOutbox.ChannelOutbox;
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      const decisions = yield* DecisionService.DecisionService;
      const { sent, transport } = fakeTransport();
      yield* registry.register(transport);
      yield* speak(otherChatAddress);
      const decision = yield* openDecision;
      yield* reactor.handleDecision(decision);
      yield* outbox.drain;
      assert.equal(sent[0]!.choices?.length, 2);

      yield* settlement.settle(decision);
      const settled = yield* decisions.get(decision.id);
      yield* reactor.handleDecision(settled);
      yield* reactor.handleDecision(settled);
      yield* outbox.drain;
      assert.lengthOf(sent, 2);
      assert.deepEqual(sent[1], {
        deliveryId: `channel-decision-settled:${decision.id}`,
        destination: otherChatAddress,
        senderName: "Jarvis",
        text: `Deploy? — ${settlement.line}`,
        language: "en",
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("no line is sent for a decision that never had a card", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    const decisions = yield* DecisionService.DecisionService;
    const decision = yield* openDecision;
    yield* reactor.handleDecision(
      yield* decisions.withdraw({ decisionId: decision.id, fromThreadId: decision.fromThreadId }),
    );
    assert.lengthOf(yield* outboxRows, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a reply for an assistant that has no record is still named", () => {
  const { layer, records } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    records.set("run-1", { messages: [{ text: "hi" }], turnItems: [] });
    yield* speak(dmAddress, "ghost");
    yield* reactor.handle(runEvent("completed", "run-1", "assistant:ghost:1"));
    assert.deepEqual(
      (yield* outboxRows).map((row) => row.message.senderName),
      ["Assistant"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("approval outcomes read as Approved or Denied", () =>
  Effect.sync(() => {
    const decision = (optionId: string, approvalRequestId?: string) =>
      ({
        status: "answered",
        options: [
          { id: "accept", label: "Approve" },
          { id: "decline", label: "Deny" },
        ],
        answer: { optionId },
        ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
      }) as unknown as Decision;
    assert.equal(Reactor.settledLine(decision("accept", "req")), "Approved");
    assert.equal(Reactor.settledLine(decision("decline", "req")), "Denied");
    assert.equal(Reactor.settledLine(decision("accept")), "Answered: Approve");
    assert.equal(
      Reactor.settledLine({ status: "answered", options: [], answer: {} } as unknown as Decision),
      "Dismissed",
    );
  }),
);

it.effect("started, it posts the cards that were open at startup without being driven", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    const outbox = yield* ChannelOutbox.ChannelOutbox;
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const delivered = yield* Deferred.make<void>();
    const { sent, transport } = fakeTransport(() =>
      Deferred.succeed(delivered, undefined).pipe(Effect.as("ts")),
    );
    yield* registry.register(transport);
    yield* speak();
    yield* openDecision;
    yield* outbox.start();
    yield* reactor.start();
    yield* Deferred.await(delivered);
    assert.equal(sent[0]!.text, "Deploy?\n\nTo production");
  }).pipe(Effect.provide(layer));
});

it.effect("a failing read is logged and never stops the event stream", () => {
  const { layer, records } = harness();
  return Effect.gen(function* () {
    const reactor = yield* Reactor.ChannelReplyReactor;
    yield* speak();
    records.get = () => {
      throw new Error("projection read failed");
    };
    yield* reactor.handle(runEvent("completed"));
    assert.lengthOf(yield* outboxRows, 0);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "in Portuguese a failure, an approval card and its outcome use the translated phrases",
  () => {
    const { layer, records } = harness("pt-BR");
    return Effect.gen(function* () {
      const reactor = yield* Reactor.ChannelReplyReactor;
      const decisions = yield* DecisionService.DecisionService;
      yield* speak();
      records.set("run-1", {
        messages: [],
        turnItems: [{ type: "error", failure: { message: "sem rede" } }],
      });
      records.set("run-2", { messages: [{ text: "Done. Approve it." }], turnItems: [] });
      yield* reactor.handle(runEvent("failed", "run-1"));
      yield* reactor.handle(runEvent("completed", "run-2"));
      const decision = yield* decisions.request({
        fromThreadId: thread as never,
        projectId: "scratch" as never,
        threadTitle: "Jarvis",
        clientRequestId: "approval:1",
        title: "Jarvis wants to run a command",
        context: "```sh\nAPI_KEY=abc123 ls\n```\n\nReason: Deny nothing",
        options: [
          { id: "accept", label: "Approve" },
          { id: "decline", label: "Deny" },
        ],
        approvalRequestId: "req-1" as never,
      });
      yield* reactor.handleDecision(decision);
      yield* decisions.answer({ decisionId: decision.id, optionId: "accept" });
      yield* reactor.handleDecision(yield* decisions.get(decision.id));
      const rows = (yield* outboxRows).map((row) => row.message);
      assert.deepEqual(
        rows.map((row) => [row.text, row.language]),
        [
          ["Não consegui terminar isso: sem rede", "pt-BR"],
          ["Done. Approve it.", "pt-BR"],
          [
            "Jarvis quer rodar um comando\n\n```sh\nAPI_KEY=[redacted] ls\n```\n\nMotivo: Deny nothing",
            "pt-BR",
          ],
          ["Jarvis quer rodar um comando — Aprovado", "pt-BR"],
        ],
      );
      assert.deepEqual(rows[2]!.choices, [
        { label: "Aprovar", value: "accept" },
        { label: "Negar", value: "decline" },
      ]);
    }).pipe(Effect.provide(layer));
  },
);
