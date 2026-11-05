import {
  WS_METHODS,
  type ImessageChannelSettings,
  type ImessageChannelStatusEvent,
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
export function applyImessageStatusEvent(
  settings: ImessageChannelSettings,
  event: ImessageChannelStatusEvent,
): ImessageChannelSettings {
  const { lastError: _lastError, lastDeliveryError: _lastDeliveryError, ...rest } = settings;
  return {
    ...rest,
    status: event.status,
    ...(event.lastError === undefined ? {} : { lastError: event.lastError }),
    ...(event.lastDeliveryError === undefined
      ? {}
      : { lastDeliveryError: event.lastDeliveryError }),
  };
}

export function createImessageChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One lane per environment keeps handle edits applied in the order they were made.
  const scheduler = createAtomCommandScheduler();
  return {
    settings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:imessage-channel:settings",
      tag: WS_METHODS.imessageChannelGetSettings,
      staleTimeMs: 30_000,
    }),
    status: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:imessage-channel:status",
      subscribe: (_input: null) => subscribe(WS_METHODS.imessageChannelSubscribeStatus, {}),
    }),
    /** The permission state before enabling; read again after the user grants access. */
    access: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:imessage-channel:access",
      tag: WS_METHODS.imessageChannelCheckAccess,
      staleTimeMs: 0,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:imessage-channel:configure",
      tag: WS_METHODS.imessageChannelConfigure,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }: { environmentId: string }) => environmentId,
      },
    }),
  };
}

const CALLING_CODES: Readonly<Record<string, string>> = {
  AR: "54",
  AU: "61",
  BR: "55",
  CA: "1",
  CH: "41",
  CL: "56",
  CO: "57",
  DE: "49",
  ES: "34",
  FR: "33",
  GB: "44",
  IE: "353",
  IN: "91",
  IT: "39",
  JP: "81",
  MX: "52",
  NL: "31",
  PE: "51",
  PT: "351",
  PY: "595",
  US: "1",
  UY: "598",
};

/** The calling code of the first locale that names a known region, such as `pt-BR` → `55`. */
export function imessageDefaultCallingCode(locales: ReadonlyArray<string>): string | undefined {
  for (const locale of locales) {
    const region = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(locale)?.[1]?.toUpperCase();
    if (region && CALLING_CODES[region]) return CALLING_CODES[region];
  }
  return undefined;
}

const group = (digits: string, sizes: ReadonlyArray<number>, separators: ReadonlyArray<string>) => {
  let out = "";
  let at = 0;
  sizes.forEach((size, index) => {
    if (at >= digits.length) return;
    out += (at === 0 ? "" : separators[index - 1]) + digits.slice(at, at + size);
    at += size;
  });
  return out + digits.slice(at);
};

/** A typed handle without the mask's separators, as the server stores it; emails are lowercased. */
export const compactImessageHandle = (value: string) =>
  value.includes("@") ? value.trim().toLowerCase() : value.replace(/[\s\-().]/g, "");

/** The Mac's own numbers and emails that neither list has yet, so one tap can add them. */
export function imessageSuggestedSelfHandles(
  ownHandles: ReadonlyArray<string>,
  settings: {
    readonly selfHandles: ReadonlyArray<string>;
    readonly allowedHandles: ReadonlyArray<string>;
  },
): ReadonlyArray<string> {
  const known = new Set(
    [...settings.selfHandles, ...settings.allowedHandles].map(compactImessageHandle),
  );
  return ownHandles.filter((handle) => !known.has(compactImessageHandle(handle)));
}

/**
 * Formats a phone number as it is typed; emails pass through. A number typed without `+` is
 * national and gets `callingCode`. Separators only appear before a digit, so backspace never sticks.
 */
export function formatImessageHandleInput(value: string, callingCode?: string): string {
  if (/[A-Za-z@_]/.test(value)) return value;
  let digits = value.replace(/\D/g, "");
  if (digits === "") return value.trim().startsWith("+") ? "+" : "";
  if (!value.trim().startsWith("+") && callingCode) {
    const international =
      digits.startsWith(callingCode) && digits.length > (callingCode === "55" ? 11 : 10);
    if (!international) digits = callingCode + digits;
  }
  if (digits.startsWith("55")) {
    const national = digits.slice(2, 13);
    if (national === "") return "+55";
    const area = national.slice(0, 2);
    const rest = national.slice(2);
    const line = rest.length > 8 ? group(rest, [5, 4], ["-"]) : group(rest, [4, 4], ["-"]);
    return `+55 (${area}${rest === "" ? "" : `) ${line}`}`;
  }
  if (digits.startsWith("1")) {
    const national = digits.slice(1, 11);
    if (national === "") return "+1";
    const area = national.slice(0, 3);
    const rest = national.slice(3);
    return `+1 (${area}${rest === "" ? "" : `) ${group(rest, [3, 4], ["-"])}`}`;
  }
  return `+${digits.slice(0, 15)}`;
}
