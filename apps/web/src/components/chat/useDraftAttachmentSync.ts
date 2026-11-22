import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  composerFileNeedsReattach,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { releaseAttachmentUpload, startAttachmentUpload } from "../../lib/attachmentUploadQueue";
import { attachmentsToReleaseOnUploadCapabilityLoss } from "./composerAttachmentFiles";
import { serializeComposerImages } from "./composerImagePersistence";

/**
 * Keeps a draft's images and files uploaded and its images persisted, for any composer that keeps
 * its attachments in the draft store: a thread's, or a group's under its draft ref.
 */
export function useDraftAttachmentSync(input: {
  readonly environmentId: EnvironmentId;
  readonly target: ComposerThreadTarget;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
  readonly canOperate: boolean;
}) {
  const {
    environmentId,
    target,
    images,
    files,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
    canOperate,
  } = input;
  const clearPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts or releases server attachment uploads as upload capability, limits and draft attachments change
  useEffect(() => {
    if (!attachmentUploadsCapabilityKnown) {
      return;
    }
    if (!supportsAttachmentUploads) {
      // Reconnect or version skew can hide upload support; retain hydrated uploads.
      for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss([...images, ...files])) {
        releaseAttachmentUpload(attachment.id);
      }
      return;
    }
    if (!canOperate) return;
    const invalidFiles =
      maxFileAttachmentBytes === null
        ? files
        : files.filter((file) => file.sizeBytes > maxFileAttachmentBytes);
    for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss(invalidFiles)) {
      releaseAttachmentUpload(attachment.id);
    }
    const uploadableFiles =
      maxFileAttachmentBytes === null
        ? []
        : files.filter((file) => file.sizeBytes <= maxFileAttachmentBytes);
    for (const attachment of [...images, ...uploadableFiles]) {
      if (attachment.type === "file" && composerFileNeedsReattach(attachment)) {
        continue;
      }
      startAttachmentUpload({ environmentId, image: attachment, draftTarget: target });
    }
  }, [
    attachmentUploadsCapabilityKnown,
    target,
    canOperate,
    files,
    images,
    environmentId,
    maxFileAttachmentBytes,
    supportsAttachmentUploads,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads draft images as data URLs and persists them to the draft store, dropping stale results on cleanup
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (images.length === 0) {
        clearPersistedAttachments(target);
        return;
      }
      const getPersistedAttachments = () => getComposerDraft(target)?.persistedAttachments ?? [];
      try {
        const serialized = await serializeComposerImages(images, getPersistedAttachments());
        if (cancelled) return;
        syncPersistedAttachments(target, serialized);
      } catch {
        const currentImageIds = new Set(images.map((image) => image.id));
        const fallback = getPersistedAttachments().filter((attachment) =>
          currentImageIds.has(attachment.id),
        );
        if (cancelled) return;
        syncPersistedAttachments(target, fallback);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, clearPersistedAttachments, images, getComposerDraft, syncPersistedAttachments]);
}
