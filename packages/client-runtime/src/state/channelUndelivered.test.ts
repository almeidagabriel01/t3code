import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { applyUndeliveredResend, createUndeliveredResend } from "./channelUndelivered.ts";
import { type AtomCommandResult, createAtomCommandScheduler } from "./runtime.ts";

const hub = "hub" as EnvironmentId;
type Shown = { readonly status?: string; readonly undeliveredCount?: number };

const setup = () => {
  const registry = AtomRegistry.make();
  const status = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  const resend = createUndeliveredResend(() => status);
  const answer = () => registry.get(resend.answers(hub));
  /** A resend that put `requeued` back in line, with `event` showing when it started. */
  const run = (event: unknown, requeued: number) => {
    registry.set(status, event === null ? AsyncResult.initial() : AsyncResult.success(event));
    const target = { environmentId: hub };
    const against = resend.command.onStart(target, registry);
    return resend.command.onSuccess(target, registry, { requeued }, against);
  };
  return { registry, resend, answer, run };
};

describe("applyUndeliveredResend", () => {
  const stale: Shown = { status: "running", undeliveredCount: 3 };
  const caughtUp: Shown = { status: "running" };
  // [case, event when the resend started, settings shown now, event now, count shown]
  it.effect.each([
    ["the stream has not reported since", stale, stale, stale, 0],
    ["no stream, over stored or saved settings", null, { undeliveredCount: 3 } as Shown, null, 0],
    ["the stream already moved on", stale, caughtUp, caughtUp, undefined],
  ] as const)("%s", ([, startedAgainst, shown, event, expected]) =>
    Effect.gen(function* () {
      const { answer, run } = setup();
      yield* run(startedAgainst, 3);
      expect(applyUndeliveredResend(shown, answer(), event).undeliveredCount).toBe(expected);
    }),
  );

  it.effect("yields to the next status event", () =>
    Effect.gen(function* () {
      const { answer, run } = setup();
      yield* run(stale, 3);
      const later = { status: "running", undeliveredCount: 1 };
      expect(applyUndeliveredResend(later, answer(), later).undeliveredCount).toBe(1);
    }),
  );

  it("changes nothing before any resend", () => {
    const { answer } = setup();
    expect(applyUndeliveredResend(stale, answer(), stale)).toBe(stale);
  });
});

it("a second press while a resend runs joins it instead of sending again", async () => {
  const { registry, resend } = setup();
  const scheduler = createAtomCommandScheduler();
  let sends = 0;
  let finish = (_: AtomCommandResult<number, never>) => {};
  const execute = () => {
    sends += 1;
    return new Promise<AtomCommandResult<number, never>>((resolve) => (finish = resolve));
  };
  const target = { environmentId: hub, input: {} };
  const first = scheduler.schedule(registry, resend.command.concurrency, target, execute);
  const second = scheduler.schedule(registry, resend.command.concurrency, target, execute);
  finish(AsyncResult.success(2));
  expect([await first, await second]).toEqual([AsyncResult.success(2), AsyncResult.success(2)]);
  expect(sends).toBe(1);
});
