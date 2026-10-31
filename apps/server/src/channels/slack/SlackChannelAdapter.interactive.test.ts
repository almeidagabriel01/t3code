import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import {
  handleSlackEnvelope,
  makeSlackChannelTransport,
  type SlackActiveSession,
} from "./SlackChannelAdapter.ts";
import { makeFakeGateway } from "./slackChannelTestSupport.ts";
import { slackChoiceBlocks } from "./slackMessageFormatting.ts";
import type { SlackBotApi, SlackSocketEnvelope } from "./SlackSdk.ts";

const classifier = {
  teamId: "T0000000001",
  botUserId: "U0000000002",
  allowedChannelIds: new Set(["C0000000001"]),
};
const connectionId = "slack-conn-1";

const envelopeFor = (body: unknown, type = "interactive") => {
  let acks = 0;
  const envelope: SlackSocketEnvelope = {
    envelopeId: "env-interactive",
    type,
    body,
    retryNum: undefined,
    retryReason: undefined,
    ack: () => {
      acks += 1;
      return Promise.resolve();
    },
  };
  return { envelope, acks: () => acks };
};

const blockActions = (
  overrides: {
    readonly userId?: string;
    readonly channelId?: string;
    readonly teamId?: string;
    readonly threadTs?: string;
    readonly actions?: ReadonlyArray<Record<string, unknown>>;
  } = {},
) => ({
  type: "block_actions",
  team: { id: overrides.teamId ?? "T0000000001" },
  user: { id: overrides.userId ?? "U0000000001", username: "alice" },
  channel: { id: overrides.channelId ?? "C0000000001", name: "general" },
  message: {
    ts: "1760000000.000200",
    thread_ts: overrides.threadTs ?? "1760000000.000100",
    text: "card",
  },
  actions: overrides.actions ?? [
    {
      type: "button",
      action_id: "t3_choice_1",
      value: "approve:A1",
      text: { type: "plain_text", text: "Approve A1" },
      action_ts: "1760000001.000100",
    },
  ],
  token: "xoxb-secret",
  response_url: "https://hooks.slack.com/actions/nope",
  trigger_id: "1337.not.used",
});

describe("Slack choice buttons", () => {
  it.effect("ingests a choice button as the clicking user's message", () => {
    const gateway = makeFakeGateway();
    const { envelope, acks } = envelopeFor(blockActions());
    return Effect.gen(function* () {
      const result = yield* handleSlackEnvelope(envelope, { connectionId, classifier });
      assert.deepEqual(result, { acked: true, handling: "ingested" });
      assert.equal(acks(), 1);
      const ingest = gateway.calls.find((call) => call.method === "ingest");
      assert.equal(ingest?.method, "ingest");
      if (ingest?.method !== "ingest") return;
      assert.equal(ingest.input.text, "Approve A1");
      assert.equal(ingest.input.choiceValue, "approve:A1");
      assert.deepEqual(ingest.input.actor, { externalActorId: "U0000000001" });
      assert.equal(ingest.input.conversationKey, "T0000000001:C0000000001");
      assert.equal(
        ingest.input.idempotencyKey,
        "T0000000001:ia:C0000000001:1760000000.000100:U0000000001:t3_choice_1:1760000001.000100",
      );
      assert.equal(ingest.input.replyAddress.rootTs, "1760000000.000100");
      assert.equal(ingest.input.replyAddress.channelId, "C0000000001");
      assert.equal(JSON.stringify(gateway.calls).includes("xoxb-secret"), false);
      assert.equal(JSON.stringify(gateway.calls).includes("hooks.slack.com"), false);
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("acks other interactive payloads and foreign action ids without ingesting", () => {
    const gateway = makeFakeGateway();
    return Effect.gen(function* () {
      for (const body of [
        { type: "shortcut", callback_id: "x" },
        { type: "view_submission", view: { id: "V1" } },
        blockActions({
          actions: [{ action_id: "approve", value: "Approve A1", action_ts: "1760000001.000100" }],
        }),
        blockActions({
          actions: [
            { action_id: "not_ours", value: "nope", action_ts: "1760000001.000100" },
            {
              action_id: "t3_choice_2",
              value: "Deny A1",
              text: { type: "plain_text", text: "Deny" },
              action_ts: "1760000001.000200",
            },
          ],
        }),
      ]) {
        const { envelope } = envelopeFor(body);
        const result = yield* handleSlackEnvelope(envelope, { connectionId, classifier });
        assert.equal(result.acked, true);
      }
      const ingested = gateway.calls.filter((call) => call.method === "ingest");
      assert.equal(ingested.length, 1);
      assert.equal(ingested[0]?.method === "ingest" ? ingested[0].input.text : undefined, "Deny");
    }).pipe(Effect.provide(gateway.layer));
  });

  it.effect("posts choice buttons next to the numbered fallback text", () => {
    const posts: Array<Parameters<SlackBotApi["postMessage"]>[0]> = [];
    const session: SlackActiveSession = {
      generation: 1,
      connectionId,
      teamId: "T0000000001",
      botUserId: "U0000000002",
      botApi: {
        authTest: () => Promise.reject(new Error("not used")),
        update: () => Promise.reject(new Error("not used")),
        postMessage: (input) => {
          posts.push(input);
          return Promise.resolve({ ts: "1760000002.000100" });
        },
      },
    };
    const transport = makeSlackChannelTransport({
      activeSession: () => Effect.succeedSome(session),
      status: () => Effect.succeed({ status: "connected" }),
      reportFailure: () => Effect.void,
    });
    return Effect.gen(function* () {
      yield* transport.send({
        deliveryId: "delivery-1",
        destination: {
          kind: "slack",
          connectionId,
          teamId: "T0000000001",
          channelId: "C0000000001",
          rootTs: "1760000000.000100",
        },
        text: "deploy staging: the agent wants to run a command.\n1. Approve A1\n2. Deny A1",
        mentionActorId: "U0000000001",
        choices: [
          { label: "Approve", value: "approve:A1" },
          { label: "Deny", value: "deny:A1" },
        ],
      });
      const [post] = posts;
      assert.equal(
        post?.text,
        "<@U0000000001> deploy staging: the agent wants to run a command.\n1. Approve A1\n2. Deny A1",
      );
      assert.deepEqual(post?.blocks, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "<@U0000000001> deploy staging: the agent wants to run a command.\n1. Approve A1\n2. Deny A1",
          },
        },
        {
          type: "actions",
          block_id: "t3_choices",
          elements: [
            {
              type: "button",
              action_id: "t3_choice_1",
              value: "approve:A1",
              text: { type: "plain_text", text: "Approve", emoji: false },
            },
            {
              type: "button",
              action_id: "t3_choice_2",
              value: "deny:A1",
              text: { type: "plain_text", text: "Deny", emoji: false },
            },
          ],
        },
      ]);
    });
  });

  it("leaves out buttons that Slack cannot hold and shortens long labels", () => {
    const blocks = slackChoiceBlocks("Pick", [
      { label: "x".repeat(100), value: "ok" },
      { label: "Too long", value: "v".repeat(2001) },
    ]);
    const actions = blocks?.[1];
    assert(actions?.type === "actions");
    assert.equal(actions.elements.length, 1);
    assert.equal(actions.elements[0]?.text.text.length, 75);
    assert.equal(slackChoiceBlocks("Pick", [{ label: "a", value: "v".repeat(2001) }]), undefined);
    const long = slackChoiceBlocks("y".repeat(5000), [{ label: "a", value: "a" }]);
    assert(long?.[0]?.type === "section");
    assert.equal(long[0].text.text.length, 3000);
  });
});
