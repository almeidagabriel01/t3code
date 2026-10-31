import { ChannelGatewayError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { describe } from "vite-plus/test";

import {
  handleSlackEnvelope,
  makeSlackChannelTransport,
  slackDeliveryError,
  type SlackActiveSession,
  type SlackDeliveryFailureReport,
} from "./SlackChannelAdapter.ts";
import {
  channelMention,
  directMessage,
  eventCallback,
  makeFakeGateway,
} from "./slackChannelTestSupport.ts";
import { SlackSdkFailure, type SlackBotApi, type SlackSocketEnvelope } from "./SlackSdk.ts";

const classifier = {
  teamId: "T0000000001",
  botUserId: "U0000000002",
  allowedChannelIds: new Set(["C0000000001"]),
};
const connectionId = "slack-conn-1";

const envelopeFor = (body: unknown, options: { type?: string; ack?: () => Promise<void> } = {}) => {
  let acks = 0;
  const envelope: SlackSocketEnvelope = {
    envelopeId: "env-1",
    type: options.type ?? "events_api",
    body,
    retryNum: undefined,
    retryReason: undefined,
    ack:
      options.ack ??
      (() => {
        acks += 1;
        return Promise.resolve();
      }),
  };
  return { envelope, acks: () => acks };
};

describe("handleSlackEnvelope", () => {
  it.effect("ACKs a gateway error without delivery fields during ingest", () => {
    const gateway = makeFakeGateway();
    gateway.script.ingest = () =>
      Effect.fail(new ChannelGatewayError({ reason: "adapter_unavailable" }));
    const envelope = envelopeFor(eventCallback(channelMention()));
    return Effect.gen(function* () {
      const result = yield* handleSlackEnvelope(envelope.envelope, {
        connectionId,
        classifier,
      });
      assert.equal(result.acked, true);
      assert.equal(envelope.acks(), 1);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect(
    "never logs a link code or forwards it to ingest, including rejected link paths",
    () => {
      const gateway = makeFakeGateway();
      const logs: unknown[] = [];
      gateway.script.linkIdentity = () =>
        Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" }));
      gateway.script.requestNotice = () =>
        Effect.fail(new ChannelGatewayError({ reason: "invalid_input" }));
      return Effect.gen(function* () {
        for (const event of [
          directMessage({ text: "link CODE_SENTINEL" }),
          directMessage({ text: "link CODE_SENTINEL extra" }),
          channelMention({ text: "<@U0000000002> link CODE_SENTINEL" }),
          directMessage(),
        ]) {
          yield* handleSlackEnvelope(envelopeFor(eventCallback(event)).envelope, {
            connectionId,
            classifier,
          });
        }
        assert(logs.length > 0);
        assert(!JSON.stringify(logs).includes("CODE_SENTINEL"));
        assert(
          !JSON.stringify(gateway.calls.filter((call) => call.method === "ingest")).includes(
            "CODE_SENTINEL",
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.merge(gateway.layer, Logger.layer([Logger.make((entry) => logs.push(entry))])),
        ),
      );
    },
  );

  it.effect("filters an explicit other-bot message before gateway ingest", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      const result = yield* handleSlackEnvelope(
        envelopeFor(eventCallback(directMessage({ user: "U0OTHERBOT", bot_id: "B0OTHER" })))
          .envelope,
        { connectionId, classifier },
      );
      assert.equal(result.acked, true);
      assert.equal(gateway.calls.length, 0);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("acknowledges only after the gateway has stored the input", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      const stored = yield* Deferred.make<void>();
      const ingestStarted = yield* Deferred.make<void>();
      gateway.script.ingest = () =>
        Deferred.succeed(ingestStarted, undefined).pipe(Effect.andThen(Deferred.await(stored)));
      const { envelope, acks } = envelopeFor(eventCallback(channelMention()));
      const fiber = yield* Effect.forkChild(
        handleSlackEnvelope(envelope, { connectionId, classifier }),
      );
      yield* Deferred.await(ingestStarted);
      assert.equal(acks(), 0);
      yield* Deferred.succeed(stored, undefined);
      const outcome = yield* Fiber.join(fiber);
      assert.deepEqual(outcome, { acked: true, handling: "ingested" });
      assert.equal(acks(), 1);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("builds the inbound message from the thread root", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      const reply = channelMention({ ts: "1760000000.000300", thread_ts: "1760000000.000100" });
      yield* handleSlackEnvelope(envelopeFor(eventCallback(reply)).envelope, {
        connectionId,
        classifier,
      });
      const call = gateway.calls[0];
      assert(call?.method === "ingest");
      assert.deepEqual(call.input.replyAddress, {
        kind: "slack",
        connectionId,
        teamId: "T0000000001",
        channelId: "C0000000001",
        rootTs: "1760000000.000100",
      });
      assert.equal(call.input.conversationKey, "T0000000001:C0000000001");
      assert.equal(call.input.externalMessageId, "1760000000.000300");
      assert.equal(call.input.idempotencyKey, "T0000000001:Ev0001AAAA");
      assert.deepEqual(call.input.actor, { externalActorId: "U0000000001" });
      assert.equal(call.input.text, "fix the login bug");
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("acknowledges a redelivered event again under the same idempotency key", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      const body = eventCallback(directMessage());
      const first = envelopeFor(body);
      const retry = envelopeFor(structuredClone(body));
      yield* handleSlackEnvelope(first.envelope, { connectionId, classifier });
      yield* handleSlackEnvelope(retry.envelope, { connectionId, classifier });
      const keys = gateway.calls.map(
        (call) => call.method === "ingest" && call.input.idempotencyKey,
      );
      assert.deepEqual(keys, ["T0000000001:Ev0001AAAA", "T0000000001:Ev0001AAAA"]);
      assert.equal(first.acks() + retry.acks(), 2);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("leaves the event for Slack to redeliver only when storage failed", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      gateway.script.ingest = () =>
        Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" }));
      const failed = envelopeFor(eventCallback(directMessage()));
      assert.deepEqual(yield* handleSlackEnvelope(failed.envelope, { connectionId, classifier }), {
        acked: false,
        handling: "redeliver",
      });
      assert.equal(failed.acks(), 0);

      gateway.script.ingest = () =>
        Effect.fail(new ChannelGatewayError({ reason: "invalid_input" }));
      const forbidden = envelopeFor(eventCallback(directMessage()));
      yield* handleSlackEnvelope(forbidden.envelope, { connectionId, classifier });
      assert.equal(forbidden.acks(), 1);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("ignores the bot's own messages and other envelope types without the gateway", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      for (const { envelope } of [
        envelopeFor(eventCallback(channelMention({ user: "U0000000002" }))),
        envelopeFor(eventCallback(directMessage({ bot_id: "B0OTHER" }))),
        envelopeFor({ type: "interactive" }, { type: "interactive" }),
      ]) {
        assert.deepEqual(yield* handleSlackEnvelope(envelope, { connectionId, classifier }), {
          acked: true,
          handling: "ignored",
        });
      }
      assert.equal(gateway.calls.length, 0);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("reports events from another workspace without passing them on", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      const { envelope, acks } = envelopeFor(
        eventCallback(channelMention(), { team_id: "T0OTHER" }),
      );
      assert.deepEqual(yield* handleSlackEnvelope(envelope, { connectionId, classifier }), {
        acked: true,
        handling: "team_mismatch",
      });
      assert.equal(acks(), 1);
      assert.equal(gateway.calls.length, 0);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("links an identity from a DM code and keeps the code out of message input", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      const { envelope, acks } = envelopeFor(eventCallback(directMessage({ text: "link ABC123" })));
      const outcome = yield* handleSlackEnvelope(envelope, { connectionId, classifier });
      assert.deepEqual(outcome, { acked: true, handling: "linked" });
      assert.equal(acks(), 1);
      assert.deepEqual(
        gateway.calls.map((call) => call.method),
        ["linkIdentity"],
      );
      const call = gateway.calls[0];
      assert(call?.method === "linkIdentity");
      assert.deepEqual(call.input, {
        connectionId,
        externalActorId: "U0000000001",
        code: "ABC123",
        idempotencyKey: "T0000000001:Ev0001AAAA",
        replyAddress: {
          kind: "slack",
          connectionId,
          teamId: "T0000000001",
          channelId: "D0000000001",
        },
      });
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("asks for a link notice instead of using an unusable link command", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      const cases = [
        [directMessage({ text: "link" }), "link_help"],
        [directMessage({ text: "link ABC123 now" }), "link_invalid"],
        [channelMention({ text: "<@U0000000002> link ABC123" }), "link_help"],
      ] as const;
      for (const [event, notice] of cases) {
        const { envelope, acks } = envelopeFor(eventCallback(event));
        assert.deepEqual(yield* handleSlackEnvelope(envelope, { connectionId, classifier }), {
          acked: true,
          handling: "noticed",
        });
        assert.equal(acks(), 1);
        const call = gateway.calls.at(-1);
        assert(call?.method === "requestNotice");
        assert.equal(call.input.notice, notice);
      }
      assert(gateway.calls.every((call) => call.method === "requestNotice"));
      assert(!JSON.stringify(gateway.calls).includes("ABC123"));
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("withholds the acknowledgement when a notice could not be stored", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      gateway.script.requestNotice = () =>
        Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" }));
      const { envelope, acks } = envelopeFor(eventCallback(directMessage({ text: "link" })));
      assert.deepEqual(yield* handleSlackEnvelope(envelope, { connectionId, classifier }), {
        acked: false,
        handling: "redeliver",
      });
      assert.equal(acks(), 0);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("survives an acknowledgement that cannot be sent", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      const { envelope } = envelopeFor(eventCallback(directMessage()), {
        ack: () => Promise.reject(new Error("socket closed")),
      });
      assert.deepEqual(yield* handleSlackEnvelope(envelope, { connectionId, classifier }), {
        acked: false,
        handling: "ingested",
      });
    }).pipe(Effect.provide(gateway.layer));
  });
});

describe("makeSlackChannelTransport", () => {
  const destination = {
    kind: "slack" as const,
    connectionId,
    teamId: "T0000000001",
    channelId: "C0000000001",
    rootTs: "1760000000.000100",
  };
  const message = {
    deliveryId: "delivery-1",
    destination,
    text: "Done: <!channel> fixed",
    mentionActorId: "U0000000001",
  };

  const setup = (
    postMessage: SlackBotApi["postMessage"],
    status: { readonly status: string; readonly lastError?: string } = { status: "connected" },
    update: SlackBotApi["update"] = () => Promise.resolve(),
  ) => {
    const posts: Array<Parameters<SlackBotApi["postMessage"]>[0]> = [];
    const updates: Array<Parameters<SlackBotApi["update"]>[0]> = [];
    const reports: Array<{ generation: number; report: SlackDeliveryFailureReport }> = [];
    const session: SlackActiveSession = {
      generation: 7,
      connectionId,
      teamId: "T0000000001",
      botUserId: "U0000000002",
      botApi: {
        authTest: () => Promise.reject(new Error("not used")),
        postMessage: (input) => {
          posts.push(input);
          return postMessage(input);
        },
        update: (input) => {
          updates.push(input);
          return update(input);
        },
      },
    };
    const transport = makeSlackChannelTransport({
      activeSession: (id) =>
        Effect.succeed(id === connectionId ? Option.some(session) : Option.none()),
      status: () => Effect.succeed(status),
      reportFailure: (_id, generation, report) =>
        Effect.sync(() => {
          reports.push({ generation, report });
        }),
    });
    return { transport, posts, updates, reports };
  };

  it.effect("posts into the original thread, tags the requester, and returns the Slack ts", () =>
    Effect.gen(function* () {
      const { transport, posts } = setup(() => Promise.resolve({ ts: "1760000002.000100" }));
      const receipt = yield* transport.send(message);
      assert.deepEqual(posts, [
        {
          channel: "C0000000001",
          threadTs: "1760000000.000100",
          text: "<@U0000000001> Done: &lt;!channel&gt; fixed",
        },
      ]);
      assert.equal(receipt.deliveryId, message.deliveryId);
      assert.equal(receipt.externalMessageId, "1760000002.000100");
    }),
  );

  const longText = Array.from({ length: 600 }, (_, index) => "step " + index + " done").join("\n");

  it.effect("posts a long reply as several messages in the thread, in order", () =>
    Effect.gen(function* () {
      let next = 0;
      const { transport, posts } = setup(() => {
        next += 1;
        return Promise.resolve({ ts: "1760000002.00010" + next });
      });
      const receipt = yield* transport.send({
        ...message,
        text: longText,
        choices: [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ],
      });
      assert.isAbove(posts.length, 1);
      assert.isTrue(posts[0]!.text.startsWith("<@U0000000001> step 0 done"));
      assert.isTrue(posts.slice(1).every((post) => !post.text.includes("U0000000001")));
      assert.isTrue(posts.every((post) => post.threadTs === "1760000000.000100"));
      assert.deepEqual(
        posts.flatMap((post) => post.text.replace("<@U0000000001> ", "").split("\n")),
        longText.split("\n"),
      );
      // Buttons go with the last part, where the question ends.
      assert.isTrue(posts.slice(0, -1).every((post) => post.blocks === undefined));
      assert.isDefined(posts.at(-1)!.blocks);
      assert.equal(receipt.externalMessageId, "1760000002.000101");
    }),
  );

  it.effect(
    "reports a failure after the first part as unknown, so the outbox does not resend",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const { transport, posts, reports } = setup(() => {
          calls += 1;
          return calls === 1
            ? Promise.resolve({ ts: "1760000002.000101" })
            : Promise.reject(
                new SlackSdkFailure({
                  operation: "chat.postMessage",
                  category: "rate_limited",
                  retryAfterSeconds: 30,
                }),
              );
        });
        const error = yield* Effect.flip(transport.send({ ...message, text: longText }));
        assert.equal(posts.length, 2);
        assert.equal(error.deliveryOutcome, "unknown");
        assert.equal(error.deliveryErrorCode, "rate_limited");
        assert.deepEqual(
          reports.map((report) => report.report.code),
          ["rate_limited"],
        );
      }),
  );

  it.effect.each([
    [
      "rate limit",
      new SlackSdkFailure({
        operation: "chat.postMessage",
        category: "rate_limited",
        retryAfterSeconds: 30,
      }),
      { deliveryOutcome: "not_sent", deliveryErrorCode: "rate_limited", retryAfterSeconds: 30 },
    ],
    [
      "revoked token",
      new SlackSdkFailure({ operation: "chat.postMessage", category: "auth_revoked" }),
      { deliveryOutcome: "not_sent", deliveryErrorCode: "token_revoked" },
    ],
    [
      "invalid token",
      new SlackSdkFailure({ operation: "chat.postMessage", category: "auth_invalid" }),
      { deliveryOutcome: "not_sent", deliveryErrorCode: "invalid_auth" },
    ],
    [
      "bot not in channel",
      new SlackSdkFailure({ operation: "chat.postMessage", category: "not_in_channel" }),
      { deliveryOutcome: "not_sent", deliveryErrorCode: "not_in_channel" },
    ],
    [
      "unknown channel",
      new SlackSdkFailure({ operation: "chat.postMessage", category: "channel_not_found" }),
      { deliveryOutcome: "not_sent", deliveryErrorCode: "channel_not_found" },
    ],
    [
      "request timeout",
      new SlackSdkFailure({ operation: "chat.postMessage", category: "timeout" }),
      { deliveryOutcome: "unknown", deliveryErrorCode: "timeout" },
    ],
    [
      "explicit rejection",
      new SlackSdkFailure({ operation: "chat.postMessage", category: "platform" }),
      { deliveryOutcome: "not_sent", deliveryErrorCode: "unknown" },
    ],
    [
      "network failure",
      new SlackSdkFailure({ operation: "chat.postMessage", category: "network" }),
      { deliveryOutcome: "unknown", deliveryErrorCode: "network" },
    ],
    [
      "reply without a ts",
      new SlackSdkFailure({ operation: "chat.postMessage", category: "unconfirmed" }),
      { deliveryOutcome: "unknown", deliveryErrorCode: "unknown" },
    ],
  ] as const)("maps a %s to what the outbox should do", ([_label, failure, expected]) =>
    Effect.gen(function* () {
      const { transport, posts, reports } = setup(() => Promise.reject(failure));
      const error = yield* Effect.flip(transport.send(message));
      assert.deepEqual<Record<string, unknown>>(
        {
          deliveryOutcome: error.deliveryOutcome,
          deliveryErrorCode: error.deliveryErrorCode,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        },
        expected,
      );
      assert.equal(error.reason, "delivery_failed");
      assert.equal(posts.length, 1);
      assert.deepEqual(reports, [
        { generation: 7, report: { code: expected.deliveryErrorCode, channelId: "C0000000001" } },
      ]);
      if (
        ["token_revoked", "invalid_auth", "not_in_channel", "channel_not_found"].includes(
          expected.deliveryErrorCode,
        )
      ) {
        assert.equal(error.deliveryOutcome, "not_sent");
        assert.equal(error.retryAfterSeconds, undefined);
      }
    }),
  );

  it.effect("tells the runtime which session hit a revoked token or a missing channel", () =>
    Effect.gen(function* () {
      const revoked = setup(() =>
        Promise.reject(
          new SlackSdkFailure({ operation: "chat.postMessage", category: "auth_revoked" }),
        ),
      );
      yield* Effect.flip(revoked.transport.send(message));
      assert.deepEqual(revoked.reports, [
        { generation: 7, report: { code: "token_revoked", channelId: "C0000000001" } },
      ]);
      const missing = setup(() =>
        Promise.reject(
          new SlackSdkFailure({ operation: "chat.postMessage", category: "channel_not_found" }),
        ),
      );
      yield* Effect.flip(missing.transport.send(message));
      assert.deepEqual(missing.reports, [
        { generation: 7, report: { code: "channel_not_found", channelId: "C0000000001" } },
      ]);
    }),
  );

  it.effect("does not post without a live session or to another workspace", () =>
    Effect.gen(function* () {
      const { transport, posts } = setup(() => Promise.resolve({ ts: "1760000002.000100" }));
      const noSession = yield* Effect.flip(
        transport.send({
          ...message,
          destination: { ...destination, connectionId: "slack-ffffffffffff" },
        }),
      );
      assert.equal(noSession.reason, "adapter_unavailable");
      const otherTeam = yield* Effect.flip(
        transport.send({ ...message, destination: { ...destination, teamId: "T0OTHER" } }),
      );
      assert.deepEqual(
        [otherTeam.reason, otherTeam.deliveryOutcome],
        ["delivery_failed", "not_sent"],
      );
      assert.equal(posts.length, 0);
    }),
  );

  it.effect("posts a direct-message reply top-level, with no thread", () =>
    Effect.gen(function* () {
      const { transport, posts } = setup(() => Promise.resolve({ ts: "1760000002.000100" }));
      const { rootTs: _rootTs, ...topLevel } = destination;
      yield* transport.send({ ...message, destination: topLevel });
      assert.equal(posts[0]?.threadTs, undefined);
    }),
  );

  it.effect("edits the replaced message in place and drops its buttons", () =>
    Effect.gen(function* () {
      const { transport, posts, updates } = setup(() => Promise.resolve({ ts: "unused" }));
      const receipt = yield* transport.send({
        ...message,
        mentionActorId: undefined,
        text: "Approved",
        choices: [{ label: "Approve", value: "approve" }],
        replacesExternalMessageId: "1760000001.000100",
      });
      assert.deepEqual(updates, [
        { channel: "C0000000001", ts: "1760000001.000100", text: "Approved" },
      ]);
      assert.equal(posts.length, 0);
      assert.equal(receipt.externalMessageId, "1760000001.000100");
    }),
  );

  it.effect(
    "posts what an edited message cannot hold as follow-ups, and reports a failed edit",
    () =>
      Effect.gen(function* () {
        const long = setup(() => Promise.resolve({ ts: "1760000002.000100" }));
        yield* long.transport.send({
          ...message,
          text: longText,
          replacesExternalMessageId: "1760000001.000100",
        });
        assert.equal(long.updates.length, 1);
        assert.isAbove(long.posts.length, 0);

        const failing = setup(
          () => Promise.resolve({ ts: "unused" }),
          { status: "connected" },
          () =>
            Promise.reject(new SlackSdkFailure({ operation: "chat.update", category: "platform" })),
        );
        const error = yield* Effect.flip(
          failing.transport.send({ ...message, replacesExternalMessageId: "1760000001.000100" }),
        );
        assert.equal(error.deliveryOutcome, "not_sent");
        assert.equal(failing.posts.length, 0);
      }),
  );

  it.effect("answers an unavailable session from the connection's status", () =>
    Effect.gen(function* () {
      const ask = (status: { readonly status: string; readonly lastError?: string }) =>
        Effect.flip(
          setup(() => Promise.resolve({ ts: "1" }), status, undefined).transport.send({
            ...message,
            destination: { ...destination, connectionId: "slack-other" },
          }),
        );
      // `setup` only serves its own connection, so any other id sees no session.
      const connecting = yield* ask({ status: "connecting" });
      assert.deepEqual(
        [connecting.reason, connecting.deliveryOutcome, connecting.deliveryErrorCode],
        ["delivery_failed", "not_sent", undefined],
      );
      const revoked = yield* ask({ status: "error", lastError: "app_uninstalled" });
      assert.equal(revoked.deliveryErrorCode, "token_revoked");
      const invalid = yield* ask({ status: "error", lastError: "invalid_token" });
      assert.equal(invalid.deliveryErrorCode, "invalid_auth");
      const disabled = yield* ask({ status: "disabled" });
      assert.equal(disabled.reason, "adapter_unavailable");
    }),
  );

  it("never claims a timed-out send was not delivered", () => {
    const error = slackDeliveryError(
      new SlackSdkFailure({ operation: "chat.postMessage", category: "network" }),
    );
    assert.equal(error.deliveryOutcome, "unknown");
  });
});
