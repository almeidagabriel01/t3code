import {
  WS_METHODS,
  type SlackChannelSettings,
  type SlackChannelStatusEvent,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** Lays a live status event over the stored settings; a stale event for another connection is ignored. */
export function applySlackStatusEvent(
  settings: SlackChannelSettings,
  event: SlackChannelStatusEvent,
): SlackChannelSettings {
  if (event.connectionId !== settings.connectionId) return settings;
  const { lastError: _lastError, lastDeliveryError: _lastDeliveryError, ...rest } = settings;
  return {
    ...rest,
    status: event.status,
    ...(event.teamId === undefined ? {} : { teamId: event.teamId }),
    ...(event.botUserId === undefined ? {} : { botUserId: event.botUserId }),
    ...(event.lastError === undefined ? {} : { lastError: event.lastError }),
    ...(event.lastDeliveryError === undefined
      ? {}
      : { lastDeliveryError: event.lastDeliveryError }),
  };
}

export function createSlackChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One lane per environment keeps token and channel edits applied in the order they were made.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial",
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  } as const;
  const command = <
    TTag extends
      | typeof WS_METHODS.slackChannelConfigure
      | typeof WS_METHODS.slackChannelDisconnect
      | typeof WS_METHODS.channelsCreateLinkCode
      | typeof WS_METHODS.channelsUnlink,
  >(
    tag: TTag,
    name: string,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:slack-channel:${name}`,
      tag,
      scheduler,
      concurrency,
    });
  return {
    settings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:slack-channel:settings",
      tag: WS_METHODS.slackChannelGetSettings,
      staleTimeMs: 30_000,
    }),
    status: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:slack-channel:status",
      subscribe: (_input: null) => subscribe(WS_METHODS.slackChannelSubscribeStatus, {}),
    }),
    identities: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:slack-channel:identities",
      tag: WS_METHODS.channelsListIdentities,
      staleTimeMs: 30_000,
    }),
    configure: command(WS_METHODS.slackChannelConfigure, "configure"),
    disconnect: command(WS_METHODS.slackChannelDisconnect, "disconnect"),
    createLinkCode: command(WS_METHODS.channelsCreateLinkCode, "create-link-code"),
    unlink: command(WS_METHODS.channelsUnlink, "unlink"),
  };
}
