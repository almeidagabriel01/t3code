import type {
  ChannelGatewayError,
  ChannelIdentityLinkConsumeInput,
  ChannelInboundMessage,
  ChannelNoticeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The one door channel input comes through. Each method stores what it was handed before it
 * succeeds, so a transport acknowledges an event only after it is safe; a `persistence_failed`
 * error means the transport should leave the event for redelivery.
 */
export class ChannelGateway extends Context.Service<
  ChannelGateway,
  {
    /** A message for an assistant, or a button press on a card the gateway sent. */
    readonly ingest: (message: ChannelInboundMessage) => Effect.Effect<void, ChannelGatewayError>;
    /** Someone replied `link <code>`; answers them with success or failure. */
    readonly linkIdentity: (
      input: ChannelIdentityLinkConsumeInput,
    ) => Effect.Effect<void, ChannelGatewayError>;
    readonly requestNotice: (input: ChannelNoticeInput) => Effect.Effect<void, ChannelGatewayError>;
  }
>()("t3/channels/ChannelGateway") {}
