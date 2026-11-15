import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

/** The row's title on every client; its description is the channel's undelivered label. */
export const UNDELIVERED_RESEND_TITLE = "Resend undelivered replies";

/**
 * How many a resend put back in line, against what supplied the count when it started: the
 * status event, or the stored settings while the stream has not reported.
 */
interface UndeliveredResendAnswer {
  readonly against: unknown;
  readonly requeued: number;
}

type Known = (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;

/**
 * A channel's resend: one request at a time per environment, a second press joins it, and its
 * answer lowers the count shown until what supplied that count changes.
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
        current(registry, status(environmentId)) ?? current(registry, settings(environmentId)),
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
 * The settings once a resend answered. The count comes from the event, or from the stored
 * settings when there is none; once that object changes it was read after the server recounted,
 * so it wins.
 */
export function applyUndeliveredResend<
  S extends { readonly undeliveredCount?: number | undefined },
>(settings: S, answer: UndeliveredResendAnswer | null, event: unknown): S {
  if (answer === null || answer.against !== (event ?? settings)) return settings;
  return lowerUndelivered(settings, answer.requeued);
}
