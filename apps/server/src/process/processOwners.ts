import { ProcessOwners, type ProcessOwner } from "@t3tools/shared/ProcessOwners";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** A pid registered at spawn may predate the sample that shows it; give it this many samples to appear. */
export const UNSEEN_SAMPLE_GRACE = 60;

interface Entry {
  readonly owner: ProcessOwner;
  readonly seen: boolean;
  readonly misses: number;
}

const make = Effect.gen(function* () {
  const entries = yield* Ref.make(new Map<number, Entry>());
  return ProcessOwners.of({
    register: Effect.fn("ProcessOwners.register")(function* (owner) {
      yield* Ref.update(entries, (current) =>
        new Map(current).set(owner.pid, { owner, seen: false, misses: 0 }),
      );
    }),
    list: Ref.get(entries).pipe(
      Effect.map((current) => [...current.values()].map(({ owner }) => owner)),
    ),
    // Runs on every telemetry sample, so it skips the span.
    retain: Effect.fnUntraced(function* (livePids: ReadonlySet<number>) {
      yield* Ref.update(entries, (current) => {
        const next = new Map<number, Entry>();
        for (const [pid, entry] of current) {
          if (livePids.has(pid)) next.set(pid, { ...entry, seen: true, misses: 0 });
          else if (!entry.seen && entry.misses + 1 < UNSEEN_SAMPLE_GRACE) {
            next.set(pid, { ...entry, misses: entry.misses + 1 });
          }
        }
        return next;
      });
    }),
  });
});

export const layer = Layer.effect(ProcessOwners, make);
