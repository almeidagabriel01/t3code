import { createAssistantGroupFileStore } from "@t3tools/client-runtime/assistantGroupChat";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  getUploadedAttachments,
  releaseAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  countPreparingComposerImages,
  usePreparingComposerImages,
} from "../chat/preparingComposerImages";

type GroupAttachment = ComposerImageAttachment | ComposerFileAttachment;

const files = createAssistantGroupFileStore<GroupAttachment>();

/** For tests: each starts with no files. */
export const clearGroupAttachments = () => files.clear();

const release = (item: GroupAttachment) => {
  if (item.type === "image") URL.revokeObjectURL(item.previewUrl);
  releaseAttachmentUpload(item.id);
};

/**
 * Files the user attaches to one group message, in the thread composer's shapes and upload queue,
 * so the thread's strip shows them. Each uploads on its own as soon as it is added, so one that
 * fails keeps its tile (retry or remove) and never costs the others.
 */
export function useGroupAttachments(
  /** The group's composer: its files outlive this mount. */
  group: string,
  environmentId: EnvironmentId,
  /** Files another message took: this composer neither shows nor sends them. */
  held: ReadonlySet<string>,
  /** Files any message on its way or refused took: leaving the chat keeps them for its resend. */
  pending: ReadonlySet<string>,
) {
  const all = useSyncExternalStore(files.subscribe, () => files.get(group));
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);
  // Images the intake is still compressing, kept apart from any thread draft's.
  const targetKey = `group:${group}`;
  const preparing = usePreparingComposerImages(targetKey);
  const items = all.filter((item) => !held.has(item.id));
  const latestPending = useRef(pending);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the unmount cleanup below reads the pending files as of the last commit
  useEffect(() => {
    latestPending.current = pending;
  });

  // Leaving the chat drops what was never sent; the object URLs and pending uploads are ours.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases object URLs and pending uploads on unmount
  useEffect(
    () => () => {
      for (const item of files.leave(group, latestPending.current)) release(item);
    },
    [group],
  );

  const add = <T extends GroupAttachment>(added: ReadonlyArray<T>): string[] => {
    files.update(group, (list) => [...list, ...added]);
    for (const image of added) startAttachmentUpload({ environmentId, image });
    return added.map((item) => item.id);
  };

  const remove = (id: string) => {
    const item = all.find((entry) => entry.id === id);
    if (item) release(item);
    files.update(group, (list) => list.filter((entry) => entry.id !== id));
  };

  /** After a send the server holds its own copies, so the ones it took can go, even after leaving. */
  const clear = (ids: ReadonlyArray<string>) => {
    for (const item of files.get(group)) if (ids.includes(item.id)) release(item);
    files.update(group, (list) => list.filter((item) => !ids.includes(item.id)));
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
    clear,
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
    reserved: () => files.get(group).length + countPreparingComposerImages(targetKey),
    full: all.length + preparing.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  };
}
