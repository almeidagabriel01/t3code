/**
 * Fakes and fixtures shared by the Slack channel tests: a recording gateway, an in-memory
 * transport registry, and Events API payloads.
 */
import type {
  ChannelGatewayError,
  ChannelIdentityLinkConsumeInput,
  ChannelInboundMessage,
  ChannelKind,
  ChannelNoticeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ChannelGateway from "../ChannelGateway.ts";
import * as ChannelTransport from "../ChannelTransport.ts";

export type GatewayCall =
  | { readonly method: "ingest"; readonly input: ChannelInboundMessage }
  | { readonly method: "linkIdentity"; readonly input: ChannelIdentityLinkConsumeInput }
  | { readonly method: "requestNotice"; readonly input: ChannelNoticeInput };

export function makeFakeGateway() {
  const calls: GatewayCall[] = [];
  const script = {
    ingest: (_input: ChannelInboundMessage): Effect.Effect<void, ChannelGatewayError> =>
      Effect.void,
    linkIdentity: (
      _input: ChannelIdentityLinkConsumeInput,
    ): Effect.Effect<void, ChannelGatewayError> => Effect.void,
    requestNotice: (_input: ChannelNoticeInput): Effect.Effect<void, ChannelGatewayError> =>
      Effect.void,
  };
  const layer = Layer.succeed(
    ChannelGateway.ChannelGateway,
    ChannelGateway.ChannelGateway.of({
      ingest: Effect.fnUntraced(function* (input) {
        calls.push({ method: "ingest", input });
        return yield* script.ingest(input);
      }),
      linkIdentity: Effect.fnUntraced(function* (input) {
        calls.push({ method: "linkIdentity", input });
        return yield* script.linkIdentity(input);
      }),
      requestNotice: Effect.fnUntraced(function* (input) {
        calls.push({ method: "requestNotice", input });
        return yield* script.requestNotice(input);
      }),
    }),
  );
  return { layer, calls, script };
}

export function makeFakeTransportRegistry() {
  const registered = new Map<ChannelKind, ChannelTransport.ChannelTransport>();
  const layer = Layer.succeed(
    ChannelTransport.ChannelTransportRegistry,
    ChannelTransport.ChannelTransportRegistry.of({
      register: Effect.fnUntraced(function* (transport) {
        yield* Effect.acquireRelease(
          Effect.sync(() => registered.set(transport.kind, transport)),
          () => Effect.sync(() => registered.delete(transport.kind)),
        );
      }),
      resolve: Effect.fnUntraced(function* (kind) {
        return yield* Effect.succeed(Option.fromNullishOr(registered.get(kind)));
      }),
    }),
  );
  return { layer, registered };
}

export const eventCallback = (
  event: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  type: "event_callback",
  team_id: "T0000000001",
  event_id: "Ev0001AAAA",
  event,
  ...overrides,
});

export const channelMention = (overrides: Record<string, unknown> = {}) => ({
  type: "app_mention",
  channel: "C0000000001",
  user: "U0000000001",
  text: "<@U0000000002> fix the login bug",
  ts: "1760000000.000100",
  ...overrides,
});

export const directMessage = (overrides: Record<string, unknown> = {}) => ({
  type: "message",
  channel_type: "im",
  channel: "D0000000001",
  user: "U0000000001",
  text: "what is running?",
  ts: "1760000000.000200",
  ...overrides,
});
