import { NoteError } from "@t3tools/contracts";
import { attachmentImageIds, replaceAttachmentImageIds } from "@t3tools/shared/attachmentImageRefs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  createPendingAttachmentId,
  parseAttachmentFileExtension,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";

const ownerOf = (noteId: string) => `note-${noteId}`;
const ownedBy = (noteId: string) => {
  const owner = toSafeThreadAttachmentSegment(ownerOf(noteId));
  return (id: string) => parseThreadSegmentFromAttachmentId(id) === owner;
};

interface NoteImagesShape {
  /** Copies pending uploads referenced by the body to stable note-owned ids. */
  readonly claim: (noteId: string, body: string) => Effect.Effect<string, NoteError>;
  /** Copies the note's own images to fresh pending uploads, so another owner can claim them. */
  readonly copyAsPending: (noteId: string, body: string) => Effect.Effect<string, NoteError>;
  /** Deletes the note-owned attachments the body names. */
  readonly release: (noteId: string, body: string) => Effect.Effect<void>;
}

export class NoteImages extends Context.Reference<NoteImagesShape>("t3/notes/NoteImages", {
  defaultValue: () => ({
    claim: (_noteId, body) => Effect.succeed(body),
    copyAsPending: (_noteId, body) => Effect.succeed(body),
    release: () => Effect.void,
  }),
}) {}

export const layerLive = Layer.effect(
  NoteImages,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
    const storeFailed = (cause: unknown) =>
      Effect.logWarning("Note image copy failed.", cause).pipe(
        Effect.andThen(
          Effect.fail(new NoteError({ reason: "storage", message: "Failed to store an image." })),
        ),
      );
    return {
      claim: Effect.fn("NoteImages.claim")(function* (noteId, body) {
        const claimed = new Map<string, string>();
        for (const attachmentId of attachmentImageIds(body)) {
          if (
            parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
          )
            continue;
          const plan = planAttachmentClaim({
            attachmentsDir: config.attachmentsDir,
            threadId: ownerOf(noteId),
            attachmentId,
          });
          if (!plan.ok) {
            return yield* new NoteError({
              reason: "invalid",
              message: `Image cannot be attached: ${plan.reason}.`,
            });
          }
          yield* fileSystem
            .copyFile(plan.currentPath, plan.finalPath)
            .pipe(Effect.catch(storeFailed));
          claimed.set(attachmentId, plan.finalId);
        }
        return replaceAttachmentImageIds(body, claimed);
      }),
      copyAsPending: Effect.fn("NoteImages.copyAsPending")(function* (noteId, body) {
        const copies = new Map<string, string>();
        for (const attachmentId of attachmentImageIds(body).filter(ownedBy(noteId))) {
          const source = resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId,
          });
          // A missing image stays a dead reference, as it already is in the note.
          if (source === null) continue;
          const pending = createPendingAttachmentId(
            parseAttachmentFileExtension(attachmentId) ?? undefined,
          );
          yield* fileSystem
            .copyFile(source, path.join(config.attachmentsDir, `${pending}${path.extname(source)}`))
            .pipe(Effect.catch(storeFailed));
          copies.set(attachmentId, pending);
        }
        return replaceAttachmentImageIds(body, copies);
      }),
      release: Effect.fn("NoteImages.release")(function* (noteId, body) {
        // A body can name anyone's attachment id; only the note's own are deleted.
        const owned = attachmentImageIds(body).filter(ownedBy(noteId));
        if (owned.length === 0) return;
        yield* cleanup
          .cleanupAttachments(owned)
          .pipe(Effect.catch((cause) => Effect.logWarning("Note image cleanup failed.", cause)));
      }),
    } satisfies NoteImagesShape;
  }),
);
