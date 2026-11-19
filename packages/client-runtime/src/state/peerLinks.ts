import { type PeerLinkSummary, WS_METHODS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createPeerLinkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:peer-links:list",
    tag: WS_METHODS.peerLinksList,
    // Listing probes every linked environment, so a list stays fresh briefly.
    staleTimeMs: 10_000,
  });
  return {
    list,
    link: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:link",
      tag: WS_METHODS.peerLinksLink,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    unlink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:unlink",
      tag: WS_METHODS.peerLinksUnlink,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    // An agent's link card. One answer per card at a time.
    answerRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:answer-request",
      tag: WS_METHODS.peerLinksAnswerRequest,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
  };
}

// Links renew themselves while the peer answers, so one this close to lapsing is not renewing.
const EXPIRY_WARNING_DAYS = 7;

/** Days left when the link is close to lapsing, otherwise null. */
type ExpiryWarning = { readonly expiresInDays: number | null };

export type PeerLinkHealth =
  | ({ readonly kind: "reachable" } & ExpiryWarning)
  | ({ readonly kind: "unreachable"; readonly detail: string | null } & ExpiryWarning)
  | ({ readonly kind: "failing"; readonly detail: string } & ExpiryWarning)
  | { readonly kind: "expired" };

/**
 * Listing only checks that the peer answers, so a link whose last call failed
 * (the peer revoked it, say) is `failing` with the recorded reason; the next
 * successful call clears it.
 */
export function peerLinkHealth(link: PeerLinkSummary, now: DateTime.Utc): PeerLinkHealth {
  if (link.status === "expired" || DateTime.isLessThanOrEqualTo(link.expiresAt, now)) {
    return { kind: "expired" };
  }
  const days = Math.ceil(Duration.toDays(DateTime.distance(now, link.expiresAt)));
  const expiresInDays = days <= EXPIRY_WARNING_DAYS ? days : null;
  if (link.status === "unreachable") {
    return { kind: "unreachable", detail: link.lastError, expiresInDays };
  }
  if (link.lastError !== null) return { kind: "failing", detail: link.lastError, expiresInDays };
  return { kind: "reachable", expiresInDays };
}

/** The line a client shows under a linked environment. */
export function peerLinkStatusText(health: PeerLinkHealth): string {
  if (health.kind === "expired") return "Expired. Link it again with a new pairing code.";
  const expiry =
    health.expiresInDays === null
      ? null
      : `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"} unless it renews.`;
  const lead =
    health.kind === "reachable"
      ? null
      : health.kind === "unreachable"
        ? (health.detail ?? "Not answering right now.")
        : health.detail;
  return [lead, expiry].filter((part) => part !== null).join(" ") || "Reachable";
}
