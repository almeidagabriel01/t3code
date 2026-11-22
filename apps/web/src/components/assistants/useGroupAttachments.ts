import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import {
  getUploadedAttachments,
  releaseAttachmentUpload,
  releaseDraftAttachment,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  countPreparingComposerImages,
  usePreparingComposerImages,
} from "../chat/preparingComposerImages";
import { useDraftAttachmentSync } from "../chat/useDraftAttachmentSync";
import { useFileAttachmentCapabilities } from "../chat/useFileAttachmentCapabilities";

export type GroupAttachment = ComposerImageAttachment | ComposerFileAttachment;

/** A reloaded file's upload is the server's attachment; any other is a queued upload. */
const releaseUpload = (item: GroupAttachment) => {
  if (item.type === "file" && item.uploadedAttachmentId !== undefined) releaseDraftAttachment(item);
  else releaseAttachmentUpload(item.id);
};

/** What a send took is the server's once it lands: its uploads and previews go. */
export const releaseGroupAttachments = (items: ReadonlyArray<GroupAttachment>) => {
  for (const item of items) {
    releaseUpload(item);
    if (item.type === "image" && item.previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
};

/**
 * Files the user attaches to a group message. Unsent ones live in the group's draft, as a thread's
 * do, so they survive a reload and light the sidebar row; a send takes them out of the draft and
 * holds them (`shown`) until the server has its own copies.
 */
export function useGroupAttachments(
  draftRef: ScopedThreadRef,
  environmentId: EnvironmentId,
  /** The files of the message this composer shows instead of its draft: a send or a refused one. */
  shown: ReadonlyArray<GroupAttachment>,
  /** Removes one of `shown` from its message. */
  onRemoveShown: (item: GroupAttachment) => void,
) {
  const draft = useComposerThreadDraft(draftRef);
  const capabilities = useFileAttachmentCapabilities(environmentId);
  useDraftAttachmentSync({
    environmentId,
    target: draftRef,
    images: draft.images,
    files: draft.files,
    attachmentUploadsCapabilityKnown: capabilities.attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads: capabilities.supportsAttachmentUploads,
    maxFileAttachmentBytes: capabilities.maxFileAttachmentBytes,
    canOperate: true,
  });
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);
  // Images the intake is still compressing, kept apart from any thread draft's.
  const targetKey = `group:${scopedThreadKey(draftRef)}`;
  const preparing = usePreparingComposerImages(targetKey);
  const items: ReadonlyArray<GroupAttachment> = [...shown, ...draft.images, ...draft.files];

  const add = <T extends GroupAttachment>(added: ReadonlyArray<T>): string[] => {
    const store = useComposerDraftStore.getState();
    const images = added.filter((item): item is T & ComposerImageAttachment => item.type === "image");
    const files = added.filter((item): item is T & ComposerFileAttachment => item.type === "file");
    return [
      ...(images.length > 0 ? store.addImages(draftRef, images) : []),
      ...(files.length > 0 ? store.addFiles(draftRef, files, { appendReference: false }) : []),
    ];
  };

  const remove = (id: string) => {
    const held = shown.find((item) => item.id === id);
    if (held) {
      onRemoveShown(held);
      releaseGroupAttachments([held]);
      return;
    }
    const store = useComposerDraftStore.getState();
    const image = draft.images.find((item) => item.id === id);
    const file = draft.files.find((item) => item.id === id);
    if (image) {
      releaseUpload(image);
      store.removeImage(draftRef, id);
    } else if (file) {
      releaseUpload(file);
      store.removeFile(draftRef, id);
    }
  };

  const images = items.filter((item) => item.type === "image");
  const attachedFiles = items.filter((item) => item.type === "file");
  return {
    targetKey,
    preparing,
    items,
    images,
    files: attachedFiles,
    add,
    remove,
    /** Moves the draft's files out for a send; files the shown message already holds stay with it. */
    take: () =>
      useComposerDraftStore.getState().takeAttachments(
        draftRef,
        [...draft.images, ...draft.files].map((item) => item.id),
      ),
    /** A refused message the user emptied gives its files back to the draft. */
    giveBack: (returned: ReadonlyArray<GroupAttachment>) => {
      add(returned);
    },
    /** Every file this message sends, once all uploaded. */
    /** Null while any is not uploaded, so a send never goes without one. */
    ready: () => getUploadedAttachments({ environmentId, images: [...images, ...attachedFiles] }),
    failed: items.some((item) => uploads[item.id]?.status === "failed"),
    /** Something is still preparing, uploading or failed: sending now would drop it. */
    unsettled:
      preparing.length > 0 ||
      items.some(
        (item) =>
          uploads[item.id]?.status !== "ready" || uploads[item.id]?.environmentId !== environmentId,
      ),
    /** Slots taken, held files included, for the intake's per-message limit. */
    reserved: () => items.length + countPreparingComposerImages(targetKey),
    full: items.length + preparing.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  };
}
