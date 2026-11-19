import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";

export interface RecordedAdapterSession {
  readonly driver: string;
  readonly events: Array<ProviderAdapter.ProviderAdapterV2Event>;
}

/** Records every event each opened provider session reports, in the order the server reads them. */
export const layerRecordingAdapterEvents = <E>(
  registryLayer: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    E,
    McpProviderSessions.McpProviderSessions
  >,
  sessions: Array<RecordedAdapterSession>,
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) =>
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        ...registry,
        get: (instanceId) =>
          Effect.map(registry.get(instanceId), (adapter) => ({
            ...adapter,
            openSession: (input) =>
              Effect.map(adapter.openSession(input), (runtime) => {
                const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
                sessions.push({ driver: adapter.driver, events });
                return {
                  ...runtime,
                  events: runtime.events.pipe(
                    Stream.tap((event) => Effect.sync(() => events.push(event))),
                  ),
                };
              }),
          })),
      }),
    ),
  ).pipe(Layer.provide(registryLayer));

/**
 * The server starts the next turn as soon as a turn's terminal update arrives, so a turn's own
 * thread and session writes must come before it: written later, they land on the next turn.
 * Checked from each turn's terminal provider turn update to its `turn.terminal`, which leaves out
 * idle updates between turns and runless subagent turns.
 */
export const turnSettlementViolations = (
  sessions: ReadonlyArray<RecordedAdapterSession>,
): ReadonlyArray<string> => [
  ...new Set(
    sessions.flatMap(({ driver, events }) =>
      events.flatMap((event, index) => {
        if (event.type !== "turn.terminal") return [];
        const ended = events.findLastIndex(
          (candidate, candidateIndex) =>
            candidateIndex < index &&
            candidate.type === "provider_turn.updated" &&
            candidate.providerTurn.id === event.providerTurnId &&
            candidate.providerTurn.status !== "running",
        );
        if (ended === -1) return [];
        return events
          .slice(ended + 1, index)
          .filter(
            (later) =>
              (later.type === "provider_thread.updated" &&
                later.providerThread.id === event.providerThreadId) ||
              later.type === "provider_session.updated",
          )
          .map((later) => `${driver} reported ${later.type} after a turn's terminal update`);
      }),
    ),
  ),
];
