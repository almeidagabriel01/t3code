import type { EnvironmentId, HostResourcesSnapshot } from "@t3tools/contracts";
import { chooseLoadBalancedEnvironment } from "@t3tools/shared/loadBalancing";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { HostToolkit } from "../mcp/toolkits/host/tools.ts";
import type * as PeerForwarding from "../peer/PeerForwarding.ts";
import type * as HostResources from "../resourceTelemetry/HostResources.ts";

const SNAPSHOT_TTL_MS = 15_000;
const REMOTE_TIMEOUT = Duration.seconds(3);
/** Server settings carry no per-environment weights, so every candidate weighs the same. */
const WEIGHT = 50;

export type SnapshotCache = Map<
  EnvironmentId,
  { readonly at: number; readonly snapshot: HostResourcesSnapshot | null }
>;

const numberAt = (value: unknown, ...path: ReadonlyArray<string>): number | null => {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
};

/** The load a peer's `t3_host status` reports, or null when it lacks any reading the score needs. */
export const snapshotFromHostStatus = (
  status: unknown,
  receivedAt: number,
): HostResourcesSnapshot | null => {
  const cpuCount = numberAt(status, "cpu", "count");
  const totalMemoryBytes = numberAt(status, "memory", "totalBytes");
  const availableMemoryBytes = numberAt(status, "memory", "availableBytes");
  if (cpuCount === null || totalMemoryBytes === null || availableMemoryBytes === null) return null;
  return {
    sampledAt: receivedAt,
    cpuUtilization: numberAt(status, "cpu", "utilization"),
    cpuCount,
    totalMemoryBytes,
    availableMemoryBytes,
  };
};

/**
 * The least loaded of `candidates`, scored as the client's Auto does; undefined when none has a
 * usable reading. A peer that does not answer within 3 s has no reading; readings live 15 s.
 */
export const pickLeastLoaded = Effect.fn("AutoEnvironmentPicker.pick")(function* (input: {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly candidates: ReadonlyArray<EnvironmentId>;
  readonly hostResources: Option.Option<HostResources.HostResources["Service"]>;
  readonly forwarding: Option.Option<PeerForwarding.PeerForwarding["Service"]>;
  readonly cache: SnapshotCache;
}) {
  const now = yield* Clock.currentTimeMillis;
  const snapshotOf = Effect.fn("AutoEnvironmentPicker.snapshot")(function* (
    environmentId: EnvironmentId,
  ) {
    if (environmentId === input.scope.environmentId) {
      return Option.isSome(input.hostResources)
        ? { ...(yield* input.hostResources.value.read), sampledAt: now }
        : null;
    }
    const cached = input.cache.get(environmentId);
    if (cached !== undefined && now - cached.at <= SNAPSHOT_TTL_MS) return cached.snapshot;
    if (Option.isNone(input.forwarding)) return null;
    const snapshot = yield* input.forwarding.value
      .call(input.scope, HostToolkit.tools.t3_host, environmentId, { action: "status" })
      .pipe(
        Effect.timeout(REMOTE_TIMEOUT),
        Effect.map((status) => snapshotFromHostStatus(status, now)),
        Effect.orElseSucceed(() => null),
      );
    input.cache.set(environmentId, { at: now, snapshot });
    return snapshot;
  });
  const scored = yield* Effect.forEach(
    input.candidates,
    (environmentId) =>
      Effect.map(snapshotOf(environmentId), (resources) => ({
        environmentId,
        resources,
        weight: WEIGHT,
      })),
    { concurrency: "unbounded" },
  );
  return (chooseLoadBalancedEnvironment(scored, now) ?? undefined) as EnvironmentId | undefined;
});
