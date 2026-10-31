/**
 * Turns Socket Mode envelopes into gateway calls, and gateway deliveries into Slack posts. An
 * envelope is acknowledged only after the gateway stored it; on `persistence_failed` it is left
 * unacknowledged so Slack redelivers it, and the idempotency key keeps that from running twice.
 */
import { ChannelGatewayError, type ChannelDeliveryErrorCode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as ChannelGateway from "../ChannelGateway.ts";
import type * as ChannelTransport from "../ChannelTransport.ts";
import {
  classifySlackEvent,
  classifySlackInteraction,
  slackActor,
  slackReplyAddress,
  toSlackInboundMessage,
  type SlackClassifierConfig,
  type SlackRevocationEvent,
} from "./slackEventMapping.ts";
import { formatSlackOutboundMessages, slackChoiceBlocks } from "./slackMessageFormatting.ts";
import {
  slackCall,
  type SlackBotApi,
  type SlackSdkFailure,
  type SlackSocketEnvelope,
} from "./SlackSdk.ts";

export type SlackEnvelopeHandling =
  | "revocation"
  | "ignored"
  | "team_mismatch"
  | "ingested"
  | "linked"
  | "noticed"
  | "redeliver";

export interface SlackEnvelopeOutcome {
  /** Whether Slack was told the envelope arrived. */
  readonly acked: boolean;
  readonly handling: SlackEnvelopeHandling;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Only a storage failure leaves the envelope for Slack to redeliver. */
const shouldRedeliver = (exit: Exit.Exit<unknown, ChannelGatewayError>) =>
  Exit.isFailure(exit) &&
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => true,
    onSome: (error) => error.reason === "persistence_failed",
  });

export const handleSlackEnvelope = Effect.fn("t3/channels/slack/handleEnvelope")(
  function* (
    envelope: SlackSocketEnvelope,
    input: {
      readonly connectionId: string;
      readonly classifier: SlackClassifierConfig;
      readonly onRevocation?: (event: SlackRevocationEvent) => Effect.Effect<boolean>;
    },
  ) {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const classification =
      envelope.type === "events_api"
        ? classifySlackEvent(envelope.body, input.classifier)
        : envelope.type === "interactive"
          ? classifySlackInteraction(envelope.body, input.classifier)
          : ({ _tag: "ignored", reason: "not_event_callback" } as const);

    let handling: SlackEnvelopeHandling;
    let exit: Exit.Exit<unknown, ChannelGatewayError> = Exit.void;
    if (classification._tag === "revocation") {
      if (input.onRevocation === undefined || !(yield* input.onRevocation(classification.event))) {
        return { acked: false, handling: "redeliver" } satisfies SlackEnvelopeOutcome;
      }
      handling = "revocation";
    } else
      switch (classification._tag) {
        case "ignored":
          handling = classification.reason === "team_mismatch" ? "team_mismatch" : "ignored";
          break;
        case "message": {
          const receivedAt = yield* nowIso;
          handling = "ingested";
          exit = yield* Effect.exit(
            gateway.ingest(
              toSlackInboundMessage(classification.event, {
                connectionId: input.connectionId,
                receivedAt,
              }),
            ),
          );
          break;
        }
        case "link":
          handling = "linked";
          exit = yield* Effect.exit(
            gateway.linkIdentity({
              connectionId: input.connectionId,
              externalActorId: classification.event.userId,
              code: classification.code,
              idempotencyKey: classification.event.dedupeKey,
              replyAddress: slackReplyAddress(classification.event, input.connectionId),
            }),
          );
          break;
        case "link_notice":
          handling = "noticed";
          exit = yield* Effect.exit(
            gateway.requestNotice({
              connectionId: input.connectionId,
              idempotencyKey: classification.event.dedupeKey,
              replyAddress: slackReplyAddress(classification.event, input.connectionId),
              actor: slackActor(classification.event),
              notice: classification.notice,
            }),
          );
          break;
      }

    if (shouldRedeliver(exit)) {
      yield* Effect.logWarning("Slack event not stored; leaving it for Slack to redeliver.");
      return { acked: false, handling: "redeliver" } satisfies SlackEnvelopeOutcome;
    }
    if (Exit.isFailure(exit)) {
      const reason = Option.match(Exit.findErrorOption(exit), {
        onNone: () => "unknown",
        onSome: (error) => error.reason,
      });
      yield* Effect.logInfo("Slack event rejected by the gateway.").pipe(
        Effect.annotateLogs({ reason }),
      );
    }
    const acked = yield* Effect.tryPromise(() => envelope.ack()).pipe(
      Effect.as(true),
      Effect.catch(() =>
        Effect.logWarning("Could not acknowledge a Slack event; Slack will redeliver it.").pipe(
          Effect.as(false),
        ),
      ),
    );
    return { acked, handling } satisfies SlackEnvelopeOutcome;
  },
  (effect, _envelope, input) =>
    effect.pipe(Effect.annotateLogs({ connectionId: input.connectionId })),
);

/** The authenticated bot session a connection is currently delivering with. */
export interface SlackActiveSession {
  readonly generation: number;
  readonly connectionId: string;
  readonly teamId: string;
  readonly botUserId: string;
  readonly botApi: SlackBotApi;
}

/** Delivery failures the connection's status should show, or that end the connection. */
export interface SlackDeliveryFailureReport {
  readonly code: ChannelDeliveryErrorCode;
  readonly channelId: string;
}

/** How the outbox should treat a failed post: retry later, give up, or record as ambiguous. */
export function slackDeliveryError(failure: SlackSdkFailure): ChannelGatewayError {
  switch (failure.category) {
    case "rate_limited":
      return new ChannelGatewayError({
        reason: "delivery_failed",
        deliveryOutcome: "not_sent",
        deliveryErrorCode: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil(failure.retryAfterSeconds ?? 1)),
      });
    case "auth_revoked":
      return deliveryFailed("not_sent", "token_revoked");
    case "auth_invalid":
      return deliveryFailed("not_sent", "invalid_auth");
    case "not_in_channel":
    case "channel_not_found":
      return deliveryFailed("not_sent", failure.category);
    case "platform":
      return deliveryFailed("not_sent", "unknown");
    case "network":
    case "timeout":
      return deliveryFailed("unknown", failure.category);
    case "http":
    case "unconfirmed":
    case "unknown":
      return deliveryFailed("unknown", "unknown");
  }
}

const deliveryFailed = (
  deliveryOutcome: "not_sent" | "unknown",
  deliveryErrorCode: ChannelDeliveryErrorCode,
) => new ChannelGatewayError({ reason: "delivery_failed", deliveryOutcome, deliveryErrorCode });

/**
 * The Slack transport: posts into the reply address's thread (top-level without `rootTs`), or
 * edits the replaced message and drops its buttons. A long reply posts as several messages with
 * buttons on the last; once one is posted a later failure is `unknown`, since a retry would repeat it.
 */
export function makeSlackChannelTransport(input: {
  readonly activeSession: (
    connectionId: string,
  ) => Effect.Effect<Option.Option<SlackActiveSession>>;
  readonly status: (
    connectionId: string,
  ) => Effect.Effect<{ readonly status: string; readonly lastError?: string }>;
  /** Ignored by the runtime unless `generation` is still the connection's current one. */
  readonly reportFailure: (
    connectionId: string,
    generation: number,
    report: SlackDeliveryFailureReport,
  ) => Effect.Effect<void>;
}): ChannelTransport.ChannelTransport {
  return {
    kind: "slack",
    send: Effect.fn("t3/channels/slack/send")(
      function* (message) {
        const destination = message.destination;
        const session = yield* input.activeSession(destination.connectionId);
        if (Option.isNone(session)) {
          const status = yield* input.status(destination.connectionId);
          if (status.status === "connecting" || status.status === "reconnecting") {
            return yield* new ChannelGatewayError({
              reason: "delivery_failed",
              deliveryOutcome: "not_sent",
            });
          }
          if (
            status.status === "error" &&
            ["token_revoked", "app_uninstalled", "invalid_token"].includes(status.lastError ?? "")
          ) {
            return yield* deliveryFailed(
              "not_sent",
              status.lastError === "invalid_token" ? "invalid_auth" : "token_revoked",
            );
          }
          return yield* new ChannelGatewayError({ reason: "adapter_unavailable" });
        }
        const active = session.value;
        if (destination.teamId !== active.teamId) {
          return yield* deliveryFailed("not_sent", "unknown");
        }
        const parts = formatSlackOutboundMessages({
          text: message.text,
          mentionUserId: message.mentionActorId,
        });
        const replaced = message.replacesExternalMessageId;
        let firstTs: string | undefined = replaced;
        for (const [index, text] of parts.entries()) {
          const blocks =
            index < parts.length - 1 || message.choices === undefined
              ? undefined
              : slackChoiceBlocks(text, message.choices);
          const post = {
            channel: destination.channelId,
            threadTs: destination.rootTs,
            text,
            ...(blocks === undefined ? {} : { blocks }),
          };
          const posted = yield* (
            index === 0 && replaced !== undefined
              ? slackCall("chat.update", () =>
                  active.botApi.update({ channel: destination.channelId, ts: replaced, text }),
                ).pipe(Effect.as({ ts: replaced }))
              : slackCall("chat.postMessage", () =>
                  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack's chat.postMessage, not window.postMessage.
                  active.botApi.postMessage(post),
                )
          ).pipe(
            Effect.catch((failure) => {
              const sent = slackDeliveryError(failure);
              const error =
                index === 0 ? sent : deliveryFailed("unknown", sent.deliveryErrorCode ?? "unknown");
              return input
                .reportFailure(destination.connectionId, active.generation, {
                  code: sent.deliveryErrorCode ?? "unknown",
                  channelId: destination.channelId,
                })
                .pipe(Effect.andThen(Effect.fail(error)));
            }),
          );
          firstTs ??= posted.ts;
        }
        return {
          deliveryId: message.deliveryId,
          acceptedAt: yield* nowIso,
          ...(firstTs === undefined ? {} : { externalMessageId: firstTs }),
        };
      },
      (effect, message) =>
        effect.pipe(Effect.annotateLogs({ channelKind: message.destination.kind })),
    ),
  };
}
