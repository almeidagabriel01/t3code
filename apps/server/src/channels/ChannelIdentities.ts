import type {
  ChannelGatewayError,
  ChannelLinkCode,
  ChannelLinkedIdentity,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Who may talk to assistants from a chat app: accounts linked with a one-time code. */
export class ChannelIdentities extends Context.Service<
  ChannelIdentities,
  {
    /** A fresh code, valid for ten minutes; only its hash is stored. */
    readonly createLinkCode: (
      connectionId: string,
    ) => Effect.Effect<ChannelLinkCode, ChannelGatewayError>;
    readonly list: (
      connectionId: string,
    ) => Effect.Effect<ReadonlyArray<ChannelLinkedIdentity>, ChannelGatewayError>;
    readonly unlink: (input: {
      readonly connectionId: string;
      readonly externalActorId: string;
    }) => Effect.Effect<void, ChannelGatewayError>;
  }
>()("t3/channels/ChannelIdentities") {}
