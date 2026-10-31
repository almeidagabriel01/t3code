import type { ChannelGatewayError, ChannelInboundMessage } from "@t3tools/contracts";
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
    /** A message for an assistant, or a number answering a card the gateway sent. */
    readonly ingest: (message: ChannelInboundMessage) => Effect.Effect<void, ChannelGatewayError>;
  }
>()("t3/channels/ChannelGateway") {}
