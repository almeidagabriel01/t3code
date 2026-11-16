import * as Option from "effect/Option";
import type { AsyncResult } from "effect/reactivity";

/** When the data shown was fetched; a refetch in flight keeps it, so it moves once per answer. */
export function queryUpdatedAt(result: AsyncResult.AsyncResult<unknown, unknown>): number {
  return result._tag === "Success"
    ? result.timestamp
    : result._tag === "Failure"
      ? (Option.getOrNull(result.previousSuccess)?.timestamp ?? 0)
      : 0;
}
