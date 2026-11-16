import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { queryUpdatedAt } from "./queryUpdatedAt.ts";

/** The row's title on every client; its description is the channel's undelivered label. */
export const UNDELIVERED_RESEND_TITLE = "Resend undelivered replies";

/**
 * How many a resend put back in line, against what supplied the count when it started: the
 * status event, or the fetch of the stored settings (its `queryUpdatedAt`) while the stream has
 * not reported.
 */
interface UndeliveredResendAnswer {
  readonly against: unknown;
  readonly requeued: number;
}

type Known = (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;

/**
 * A channel's resend: one request at a time per environment, a second press joins it, and its
 * answer lowers the count shown until the next status event or settings fetch.
 */
export function createUndeliveredResend(status: Known, settings: Known) {
  const answers = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<UndeliveredResendAnswer | null>(null),
  );
  const current = (
    registry: AtomRegistry.AtomRegistry,
    atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>,
  ) => AsyncResult.getOrElse(registry.get(atom), () => null);
  return {
    answers,
    command: {
      concurrency: {
        mode: "singleFlight" as const,
        key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
      },
      onStart: (
        { environmentId }: { readonly environmentId: EnvironmentId },
        registry: AtomRegistry.AtomRegistry,
      ): unknown =>
        current(registry, status(environmentId)) ??
        queryUpdatedAt(registry.get(settings(environmentId))),
      onSuccess: (
        { environmentId }: { readonly environmentId: EnvironmentId },
        registry: AtomRegistry.AtomRegistry,
        result: { readonly requeued: number },
        against: unknown,
      ) =>
        Effect.sync(() =>
          registry.set(answers(environmentId), {
            against,
            requeued: result.requeued,
          }),
        ),
    },
  };
}

/** The settings with `requeued` fewer undelivered replies. */
export function lowerUndelivered<S extends { readonly undeliveredCount?: number | undefined }>(
  settings: S,
  requeued: number,
): S {
  return {
    ...settings,
    undeliveredCount: Math.max(0, (settings.undeliveredCount ?? 0) - requeued),
  };
}

/**
 * The settings once a resend answered. The count comes from the event, or, when there is none,
 * from the settings fetched at `fetchedAt`. A newer event or fetch was read after the server
 * recounted, so it wins even when its content is the same.
 */
export function applyUndeliveredResend<
  S extends { readonly undeliveredCount?: number | undefined },
>(settings: S, answer: UndeliveredResendAnswer | null, event: unknown, fetchedAt: number): S {
  if (answer === null || answer.against !== (event ?? fetchedAt)) return settings;
  return lowerUndelivered(settings, answer.requeued);
}

/** Settings and when they arrived: a fetch's `queryUpdatedAt`, or when a change answered them. */
export interface StoredSettings<S> {
  readonly value: S;
  readonly at: number;
}

/** What a change saved until a fetch finishes after it; then that fetch. */
export function newerStoredSettings<S>(
  saved: StoredSettings<S> | null,
  fetched: S | null,
  fetchedAt: number,
): StoredSettings<S> | null {
  if (saved !== null && (fetched === null || saved.at >= fetchedAt)) return saved;
  return fetched === null ? null : { value: fetched, at: fetchedAt };
}
