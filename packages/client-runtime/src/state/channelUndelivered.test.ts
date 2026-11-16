import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  applyUndeliveredResend,
  createUndeliveredResend,
  newerStoredSettings,
} from "./channelUndelivered.ts";
import { queryUpdatedAt } from "./queryUpdatedAt.ts";
import { type AtomCommandResult, createAtomCommandScheduler } from "./runtime.ts";

const hub = "hub" as EnvironmentId;
type Shown = { readonly status?: string; readonly undeliveredCount?: number };

const setup = () => {
  const registry = AtomRegistry.make();
  const status = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  const stored = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  const resend = createUndeliveredResend(
    () => status,
    () => stored,
  );
  const answer = () => registry.get(resend.answers(hub));
  const known = (value: unknown, timestamp = 1) =>
    value === null ? AsyncResult.initial() : AsyncResult.success(value, { timestamp });
  /** A resend that put `requeued` back in line, with `event` and `settings` shown when it started. */
  const run = (event: unknown, requeued: number, settings: unknown = null) => {
    registry.set(status, known(event));
    registry.set(stored, known(settings));
    const target = { environmentId: hub };
    const against = resend.command.onStart(target, registry);
    return resend.command.onSuccess(target, registry, { requeued }, against);
  };
  /** A fetch that finished after the resend started, answering `settings`. */
  const refetch = (settings: unknown) => registry.set(stored, known(settings, 2));
  const fetchedAt = () => queryUpdatedAt(registry.get(stored));
  return { registry, resend, answer, run, refetch, fetchedAt };
};

describe("applyUndeliveredResend", () => {
  const stale: Shown = { status: "running", undeliveredCount: 3 };
  const caughtUp: Shown = { status: "running" };
  const fetched: Shown = { undeliveredCount: 3 };
  const refetched: Shown = { undeliveredCount: 2 };
  // [case, event and settings when the resend started, settings shown now, fetched since, event now, count shown]
  it.effect.each([
    ["the stream has not reported since", stale, fetched, stale, false, stale, 0],
    ["no stream, over the same settings", null, fetched, fetched, false, null, 0],
    ["the stream already moved on", stale, fetched, caughtUp, false, caughtUp, undefined],
    ["no stream, and the settings were fetched again", null, fetched, refetched, true, null, 2],
    ["no stream, and a fetch answered the same settings", null, fetched, fetched, true, null, 3],
  ] as const)("%s", ([, startedEvent, startedSettings, shown, fetchedSince, event, expected]) =>
    Effect.gen(function* () {
      const { answer, run, refetch, fetchedAt } = setup();
      yield* run(startedEvent, 3, startedSettings);
      if (fetchedSince) refetch(shown);
      expect(applyUndeliveredResend(shown, answer(), event, fetchedAt()).undeliveredCount).toBe(
        expected,
      );
    }),
  );

  it.effect("yields to the next status event", () =>
    Effect.gen(function* () {
      const { answer, run, fetchedAt } = setup();
      yield* run(stale, 3);
      const later = { status: "running", undeliveredCount: 1 };
      expect(applyUndeliveredResend(later, answer(), later, fetchedAt()).undeliveredCount).toBe(1);
    }),
  );

  it("changes nothing before any resend", () => {
    const { answer } = setup();
    expect(applyUndeliveredResend(stale, answer(), stale, 0)).toBe(stale);
  });
});

describe("newerStoredSettings", () => {
  const saved = { value: "saved", at: 2 };
  // [case, saved, fetched, fetched at, shown]
  it.each([
    ["nothing saved shows the fetch", null, "fetched", 1, { value: "fetched", at: 1 }],
    ["a save after the fetch wins", saved, "fetched", 1, saved],
    ["a fetch that finished after the save wins", saved, "fetched", 3, { value: "fetched", at: 3 }],
    ["a save shows before any fetch", saved, null, 0, saved],
  ] as const)("%s", (_, stored, fetched, fetchedAt, shown) => {
    expect(newerStoredSettings(stored, fetched, fetchedAt)).toEqual(shown);
  });
});

it("a second press while a resend runs joins it instead of sending again", async () => {
  const { registry, resend } = setup();
  const scheduler = createAtomCommandScheduler();
  let sends = 0;
  type Finish = (result: AtomCommandResult<number, never>) => void;
  // Settles once the scheduler actually runs the send, with the function that answers it.
  const started = Promise.withResolvers<Finish>();
  const execute = () => {
    sends += 1;
    return new Promise<AtomCommandResult<number, never>>((resolve) => started.resolve(resolve));
  };
  const target = { environmentId: hub, input: {} };
  const first = scheduler.schedule(registry, resend.command.concurrency, target, execute);
  const second = scheduler.schedule(registry, resend.command.concurrency, target, execute);
  (await started.promise)(AsyncResult.success(2));
  expect([await first, await second]).toEqual([AsyncResult.success(2), AsyncResult.success(2)]);
  expect(sends).toBe(1);
});
