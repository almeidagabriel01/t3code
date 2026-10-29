import * as M from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  decodeFailureCode,
  decodeFailureEnvironment,
  stored,
  workMetadataCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryStoreConflict, MemoryWork, strict } from "./StoreModel.ts";
import type { WorkQueue } from "./WorkQueue.ts";

export const makeGenerationFailure = (
  kernel: Pick<StoreKernel, "sql" | "transact">,
  workQueue: Pick<WorkQueue, "finishWork" | "readWork" | "retryWork">,
) => {
  const { sql, transact } = kernel;
  const { finishWork, readWork, retryWork } = workQueue;
  const failGenerationAttempt = Effect.fn("MemoryStore.failGenerationAttempt")(function* (input: {
    work: MemoryWork;
    environmentId: M.EnvironmentId;
    failureCode: M.MemoryFailureCode;
    now: number;
    retryAt: number | null;
  }) {
    return yield* transact(
      Effect.gen(function* () {
        const work = input.work;
        const code = yield* stored("failure-code", decodeFailureCode(input.failureCode, strict));
        const environment = yield* stored(
          "failure-environment",
          decodeFailureEnvironment(input.environmentId, strict),
        );
        const current = yield* readWork(work.id);
        if (
          !current ||
          current.status !== "running" ||
          work.status !== "running" ||
          work.claimedBy === null ||
          work.claimedUntil === null ||
          current.claimedBy !== work.claimedBy ||
          current.claimedUntil !== work.claimedUntil ||
          current.attempt !== work.attempt ||
          current.claimedUntil <= input.now
        )
          return false;
        if (
          current.space !== work.space ||
          current.memoryId !== work.memoryId ||
          (yield* workMetadataCodec.encode(current.metadata)) !==
            (yield* workMetadataCodec.encode(work.metadata))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const metadata = current.metadata;
        if (
          metadata.kind !== "summary" ||
          !current.memoryId ||
          metadata.sourceThread.environmentId !== environment ||
          !["summary", "consolidate"].includes(current.kind)
        )
          return yield* new MemoryStoreConflict({ code: "unsupported_operation" });
        yield* stored(
          "generation-failure-code",
          sql`UPDATE memory_outbox SET failure_code=${code} WHERE id=${current.id}`,
        );
        if (input.retryAt !== null) yield* retryWork(current, input.retryAt);
        else yield* finishWork(current.id, "failed");
        return true;
      }),
    );
  });
  return { failGenerationAttempt };
};
