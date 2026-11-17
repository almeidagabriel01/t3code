import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { isLockBusy, LOCK_ASYNC_RETRY_MS, SERVER_LOCK_WAIT_MS } from "./queueFile.ts";

const triesWithin = (ceilingMs: number | null) =>
  ceilingMs === null ? {} : { times: Math.ceil(ceilingMs / LOCK_ASYNC_RETRY_MS) };

/** Runs a locked call, retrying a busy lock every 50 ms until `ceilingMs`; null waits on. */
export const whenLockFree = <A, E>(
  run: () => A,
  onError: (cause: unknown) => E,
  ceilingMs: number | null = SERVER_LOCK_WAIT_MS,
) =>
  Effect.try({
    try: run,
    catch: (cause) => ({ busy: isLockBusy(cause), error: onError(cause) }),
  }).pipe(
    Effect.retry({
      while: (failed) => failed.busy,
      schedule: Schedule.spaced(LOCK_ASYNC_RETRY_MS),
      ...triesWithin(ceilingMs),
    }),
    Effect.mapError((failed) => failed.error),
  );
