import {
  WS_METHODS,
  type TelegramChannelDeliveryError,
  type TelegramChannelErrorCode,
  type TelegramChannelSettings,
  type TelegramChannelStatusEvent,
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

/** Lays a live status event over the stored settings; the event replaces status and errors. */
export function applyTelegramStatusEvent(
  settings: TelegramChannelSettings,
  event: TelegramChannelStatusEvent,
): TelegramChannelSettings {
  const {
    lastError: _lastError,
    lastDeliveryError: _lastDeliveryError,
    botUsername: _botUsername,
    ...rest
  } = settings;
  const botUsername = event.botUsername ?? settings.botUsername;
  return {
    ...rest,
    status: event.status,
    ...(event.lastError === undefined ? {} : { lastError: event.lastError }),
    ...(event.lastDeliveryError === undefined
      ? {}
      : { lastDeliveryError: event.lastDeliveryError }),
    ...(botUsername === undefined ? {} : { botUsername }),
  };
}

export function createTelegramChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One lane per environment keeps edits applied in the order they were made.
  const scheduler = createAtomCommandScheduler();
  return {
    settings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:telegram-channel:settings",
      tag: WS_METHODS.telegramChannelGetSettings,
      staleTimeMs: 30_000,
    }),
    status: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:telegram-channel:status",
      subscribe: (_input: null) => subscribe(WS_METHODS.telegramChannelSubscribeStatus, {}),
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:telegram-channel:configure",
      tag: WS_METHODS.telegramChannelConfigure,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }: { environmentId: string }) => environmentId,
      },
    }),
  };
}

/** What a person types for a Telegram user id: digits only, as the server stores it. */
export const compactTelegramUserId = (value: string) => value.replace(/\D/g, "");

const ERROR_COPY: Readonly<Record<TelegramChannelErrorCode, string>> = {
  invalid_token:
    "Telegram does not accept this bot token. Copy it again from @BotFather, or create a new one.",
  conflict:
    "Another program is already reading this bot's messages. Stop it, or use a different bot.",
  unreachable: "T3 Code cannot reach Telegram right now. It keeps trying.",
  rate_limited: "Telegram asked T3 Code to slow down. It keeps trying.",
};

export function telegramStatusLabel(
  settings: Pick<TelegramChannelSettings, "status" | "lastError">,
): string {
  switch (settings.status) {
    case "disabled":
      return "Off";
    case "running":
      return "Connected";
    case "error":
      return (
        (settings.lastError && ERROR_COPY[settings.lastError]) ||
        "Telegram stopped working. Check the bot token and try again."
      );
  }
}

const DELIVERY_COPY: Readonly<Record<string, string>> = {
  chat_not_found: "the chat was not found; send the bot a message first",
  timeout: "Telegram did not answer in time",
  unknown: "of an unknown error",
};

/** Why the last reply was not delivered; callers add the relative time. */
export function telegramDeliveryErrorReason(
  error: Pick<TelegramChannelDeliveryError, "code">,
): string {
  return DELIVERY_COPY[error.code] ?? DELIVERY_COPY.unknown!;
}

/** Why the switch cannot be turned on yet, or null when it can. */
export function telegramSwitchHint(
  settings: Pick<TelegramChannelSettings, "tokenConfigured" | "allowedUserIds">,
): string | null {
  const noToken = !settings.tokenConfigured;
  const noIds = settings.allowedUserIds.length === 0;
  if (noToken && noIds) return "Add the bot token and at least one user id before turning this on.";
  if (noToken) return "Add the bot token before turning this on.";
  if (noIds) return "Add at least one user id before turning this on.";
  return null;
}
