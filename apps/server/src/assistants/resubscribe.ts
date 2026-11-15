import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** A stream that ends in error subscribes again, backing off up to half a minute. */
export const RESUBSCRIBE = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);
