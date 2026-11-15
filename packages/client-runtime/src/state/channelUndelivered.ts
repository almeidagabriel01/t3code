import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

/** The row's title on every client; its description is the channel's undelivered label. */
export const UNDELIVERED_RESEND_TITLE = "Resend undelivered replies";

/** How many a resend put back in line, against the status event showing when it started. */
interface UndeliveredResendAnswer {
  readonly against: unknown;
  readonly requeued: number;
}

/**
 * A channel's resend: one request at a time per environment, a second press joins it, and its
 * answer lowers the count shown until the live status reports again.
 */
export function createUndeliveredResend(
  status: (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>,
) {
  const answers = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<UndeliveredResendAnswer | null>(null),
  );
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
      ): unknown => AsyncResult.getOrElse(registry.get(status(environmentId)), () => null),
      onSuccess: (
        { environmentId }: { readonly environmentId: EnvironmentId },
        registry: AtomRegistry.AtomRegistry,
        result: { readonly requeued: number },
        against: unknown,
      ) =>
        Effect.sync(() =>
          registry.set(answers(environmentId), {
            against: against ?? null,
            requeued: result.requeued,
          }),
        ),
    },
  };
}

/**
 * The settings once a resend answered. The server recounts before it replies, so an event newer
 * than the one the resend started against already holds the right count and wins.
 */
export function applyUndeliveredResend<
  S extends { readonly undeliveredCount?: number | undefined },
>(settings: S, answer: UndeliveredResendAnswer | null, event: unknown): S {
  if (answer === null || answer.against !== event) return settings;
  return {
    ...settings,
    undeliveredCount: Math.max(0, (settings.undeliveredCount ?? 0) - answer.requeued),
  };
}
