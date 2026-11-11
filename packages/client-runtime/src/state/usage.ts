import type { EnvironmentId, UsageModelFilter, UsageSummaryInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/** The Usage tab asks each environment with that environment's configured model filter. */
export function usageSummaryInput(
  input: UsageSummaryInput,
  modelFilter: UsageModelFilter | undefined,
): UsageSummaryInput {
  return modelFilter === undefined ? input : { ...input, modelFilter };
}

const limitsRefreshedAt = new Map<EnvironmentId, number>();
const limitsRefreshes = new Map<
  EnvironmentId,
  { readonly fresh: boolean; readonly promise: Promise<unknown> }
>();

/**
 * One limits refresh per environment at a time. `refresh` receives `fresh`: true for a refresh the
 * user asked for, which must reach the provider instead of a cached reading. Automatic refreshes
 * are throttled; a manual one never settles for an automatic check that is already running.
 */
export async function refreshUsageLimits<A>(
  environmentId: EnvironmentId,
  refresh: (fresh: boolean) => Promise<A>,
  automatic = false,
  afterPending = false,
  minIntervalMs = 5 * 60_000,
): Promise<A | undefined> {
  const pending = limitsRefreshes.get(environmentId);
  if (pending !== undefined) {
    if (afterPending || (!automatic && !pending.fresh)) {
      try {
        await pending.promise;
      } catch {}
      return refreshUsageLimits(environmentId, refresh, false, afterPending, minIntervalMs);
    }
    return automatic ? undefined : ((await pending.promise) as A);
  }
  const refreshedAt = limitsRefreshedAt.get(environmentId) ?? 0;
  // @effect-diagnostics-next-line globalDate:off
  if (automatic && Date.now() < refreshedAt + minIntervalMs) return;
  const promise = Promise.resolve()
    .then(() => refresh(!automatic))
    .finally(() => {
      limitsRefreshes.delete(environmentId);
      // @effect-diagnostics-next-line globalDate:off
      limitsRefreshedAt.set(environmentId, Date.now());
    });
  limitsRefreshes.set(environmentId, { fresh: !automatic, promise });
  return await promise;
}

export async function refreshUsage({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "usageSummary" | "refreshUsageRates" | "usageModelFilterAtom"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({
        environmentId,
        input: usageSummaryInput(input, registry.get(server.usageModelFilterAtom(environmentId))),
      });
      const presentation = presentations.presentationAtom(environmentId);
      const controller = new AbortController();
      const abortWhenDisconnected = () => {
        if (registry.get(presentation)?.connection.phase !== "connected") controller.abort();
      };
      const unsubscribe = registry.subscribe(presentation, abortWhenDisconnected);
      abortWhenDisconnected();
      try {
        const ratesResult = await runAtomCommand(
          registry,
          server.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        const sessionUnavailable =
          ratesResult._tag === "Failure" &&
          isEnvironmentRpcUnavailable(squashAtomCommandFailure(ratesResult));
        registry.refresh(query);
        if (sessionUnavailable || controller.signal.aborted) return;
        await executeAtomQuery(registry, query, {
          reportFailure: false,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
      }
    }),
  );
}
