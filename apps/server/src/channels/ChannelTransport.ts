import type {
  ChannelDeliveryReceipt,
  ChannelGatewayError,
  ChannelKind,
  ChannelOutboundMessage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

/** The port a channel adapter implements to deliver. Core code never imports a channel SDK. */
export interface ChannelTransport {
  readonly kind: ChannelKind;
  /**
   * Delivers one message. Delivery is at least once: a timeout does not prove the channel did
   * not receive it, so adapters return the external message id whenever they get one.
   */
  readonly send: (
    message: ChannelOutboundMessage,
  ) => Effect.Effect<ChannelDeliveryReceipt, ChannelGatewayError>;
}

export class ChannelTransportRegistry extends Context.Service<
  ChannelTransportRegistry,
  {
    /** Registers an adapter until the surrounding scope closes. One adapter per kind. */
    readonly register: (transport: ChannelTransport) => Effect.Effect<void, never, Scope.Scope>;
    readonly resolve: (kind: ChannelKind) => Effect.Effect<Option.Option<ChannelTransport>>;
  }
>()("t3/channels/ChannelTransport/ChannelTransportRegistry") {}

const makeRegistry = Effect.gen(function* () {
  const transports = yield* Ref.make(new Map<ChannelKind, ChannelTransport>());
  return ChannelTransportRegistry.of({
    register: Effect.fn("ChannelTransportRegistry.register")(function* (transport) {
      yield* Effect.acquireRelease(
        Ref.update(transports, (current) => new Map(current).set(transport.kind, transport)),
        () =>
          Ref.update(transports, (current) => {
            if (current.get(transport.kind) !== transport) return current;
            const next = new Map(current);
            next.delete(transport.kind);
            return next;
          }),
      );
    }),
    resolve: Effect.fn("ChannelTransportRegistry.resolve")(function* (kind) {
      return Option.fromNullishOr((yield* Ref.get(transports)).get(kind));
    }),
  });
});

export const layer = Layer.effect(ChannelTransportRegistry, makeRegistry);
