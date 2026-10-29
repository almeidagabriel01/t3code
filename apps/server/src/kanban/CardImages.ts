import { KanbanError } from "@t3tools/contracts";
import { attachmentImageIds, replaceAttachmentImageIds } from "@t3tools/shared/attachmentImageRefs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";

const ownerOf = (cardId: string) => `card-${cardId}`;

interface KanbanCardImagesShape {
  /** Copies pending uploads to stable card-owned ids; maps each pending id to its new id. */
  readonly claimIds: (
    cardId: string,
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>, KanbanError>;
  /** Copies pending uploads referenced by the description to stable card-owned ids. */
  readonly claim: (cardId: string, description: string) => Effect.Effect<string, KanbanError>;
  /** Deletes the card-owned attachments among `attachmentIds` and those the description names. */
  readonly release: (
    cardId: string,
    description: string,
    attachmentIds?: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
}

export class KanbanCardImages extends Context.Reference<KanbanCardImagesShape>(
  "t3/kanban/KanbanCardImages",
  {
    defaultValue: () => ({
      claimIds: (_cardId, ids) => Effect.succeed(new Map(ids.map((id) => [id, id]))),
      claim: (_cardId, description) => Effect.succeed(description),
      release: () => Effect.void,
    }),
  },
) {}

export const layerLive = Layer.effect(
  KanbanCardImages,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
    const claimIds = Effect.fn("KanbanCardImages.claimIds")(function* (
      cardId: string,
      attachmentIds: ReadonlyArray<string>,
    ) {
      const claimed = new Map<string, string>();
      for (const attachmentId of attachmentIds) {
        const plan = planAttachmentClaim({
          attachmentsDir: config.attachmentsDir,
          threadId: ownerOf(cardId),
          attachmentId,
        });
        if (!plan.ok) {
          return yield* new KanbanError({
            kind: "invalid",
            message: `File cannot be attached: ${plan.reason}.`,
          });
        }
        yield* fileSystem
          .copyFile(plan.currentPath, plan.finalPath)
          .pipe(
            Effect.mapError(
              (cause) =>
                new KanbanError({ kind: "internal", message: "Failed to store file.", cause }),
            ),
          );
        claimed.set(attachmentId, plan.finalId);
      }
      return claimed;
    });
    return {
      claimIds,
      claim: Effect.fn("KanbanCardImages.claim")(function* (cardId, description) {
        const pending = attachmentImageIds(description).filter(
          (id) => parseThreadSegmentFromAttachmentId(id) === PENDING_ATTACHMENT_THREAD_SEGMENT,
        );
        return replaceAttachmentImageIds(description, yield* claimIds(cardId, pending));
      }),
      release: Effect.fn("KanbanCardImages.release")(function* (
        cardId,
        description,
        attachmentIds = [],
      ) {
        const owner = toSafeThreadAttachmentSegment(ownerOf(cardId));
        // A description can name anyone's attachment id; only the card's own are deleted.
        const owned = [...new Set([...attachmentImageIds(description), ...attachmentIds])].filter(
          (id) => parseThreadSegmentFromAttachmentId(id) === owner,
        );
        if (owned.length === 0) return;
        yield* cleanup
          .cleanupAttachments(owned)
          .pipe(Effect.catch((cause) => Effect.logWarning("Card image cleanup failed.", cause)));
      }),
    } satisfies KanbanCardImagesShape;
  }),
);
