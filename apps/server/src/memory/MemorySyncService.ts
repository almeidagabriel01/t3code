import type * as M from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Service from "./MemoryService.ts";

type Permit = Effect.Effect<void, Service.MemoryAccessError>;

/**
 * The slice of the sync service that snapshots and settings call. The sync implementation
 * extends this contract and supplies the layer.
 */
export class MemorySyncService extends Context.Service<
  MemorySyncService,
  {
    readonly readLocalReadiness: () => Effect.Effect<
      { memorySpaceId: M.MemorySpaceId | null; bootstrap: "unbound" | "staging" | "ready" },
      Error
    >;
    readonly updateHubSettings: (
      input: M.MemoryHubSettingsUpdateInput,
      permit: Permit,
    ) => Effect.Effect<
      M.MemoryHubSettingsUpdateResult,
      M.MemoryHubError | Service.MemoryAccessError
    >;
  }
>()("t3/memory/MemorySyncService") {}
