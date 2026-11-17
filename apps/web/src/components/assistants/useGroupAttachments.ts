import { createAssistantGroupFileStore } from "@t3tools/client-runtime/assistantGroupChat";
import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  discardStandaloneAttachment,
  uploadStandaloneAttachment,
} from "../../lib/attachmentUploadQueue";
import { randomUUID } from "../../lib/utils";

export interface GroupAttachmentItem {
  readonly id: string;
  readonly file: File;
  /** Object URL for images, revoked when the item leaves the list. */
  readonly previewUrl: string | null;
  readonly progress: number;
  readonly error: string | null;
  /** Set once the upload finished: what the post sends. */
  readonly attachment: ChatAttachment | null;
}

/** The post's attachment record for an uploaded file, as the thread composer would send it. */
function toChatAttachment(file: File, uploaded: { attachmentId: string; mimeType: string }) {
  const image = isProviderSendTurnSupportedImageMimeType(uploaded.mimeType);
  return {
    type: image ? "image" : "file",
    id: uploaded.attachmentId,
    name: file.name || (image ? "image" : "file"),
    mimeType: uploaded.mimeType,
    sizeBytes: file.size,
  } as ChatAttachment;
}

const files = createAssistantGroupFileStore<GroupAttachmentItem>();

/** For tests: each starts with no files. */
export const clearGroupAttachments = () => files.clear();

/**
 * Files the user attaches to one group message. Each uploads on its own as soon as it is added, so
 * one that fails keeps its chip (retry or remove) and never costs the others.
 */
export function useGroupAttachments(
  /** The group's composer: its files outlive this mount. */
  group: string,
  environmentId: EnvironmentId,
  disabled: boolean,
  /** Files another message took: this composer neither shows nor sends them. */
  held: ReadonlySet<string>,
  /** Files any message on its way or refused took: leaving the chat keeps them for its resend. */
  pending: ReadonlySet<string>,
) {
  const all = useSyncExternalStore(files.subscribe, () => files.get(group));
  const setItems = (
    change: (list: ReadonlyArray<GroupAttachmentItem>) => ReadonlyArray<GroupAttachmentItem>,
  ) => files.update(group, change);
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
      for (const item of files.leave(group, latestPending.current)) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        if (item.attachment) discardStandaloneAttachment(environmentId, item.attachment.id);
      }
    },
    [group, environmentId],
  );

  const update = (id: string, change: Partial<GroupAttachmentItem>) =>
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));

  const run = async (item: GroupAttachmentItem) => {
    try {
      const uploaded = await uploadStandaloneAttachment(environmentId, item.file, (progress) =>
        update(item.id, { progress }),
      );
      update(item.id, { progress: 1, attachment: toChatAttachment(item.file, uploaded) });
    } catch (cause) {
      update(item.id, { error: cause instanceof Error ? cause.message : "Upload failed" });
    }
  };

  const release = (item: GroupAttachmentItem, discard: boolean) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    if (discard && item.attachment) discardStandaloneAttachment(environmentId, item.attachment.id);
  };

  const add = (files: ReadonlyArray<File>) => {
    if (disabled || files.length === 0) return;
    const room = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - all.length;
    const added = files.slice(0, Math.max(room, 0)).map((file): GroupAttachmentItem => ({
      id: randomUUID(),
      file,
      previewUrl: isProviderSendTurnSupportedImageMimeType(file.type)
        ? URL.createObjectURL(file)
        : null,
      progress: 0,
      error: null,
      attachment: null,
    }));
    setItems((list) => [...list, ...added]);
    for (const item of added) void run(item);
  };

  const remove = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    if (item) release(item, true);
    setItems((list) => list.filter((entry) => entry.id !== id));
  };

  const retry = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    if (item === undefined) return;
    const reset = { ...item, progress: 0, error: null };
    update(id, reset);
    void run(reset);
  };

  /** After a send the server holds its own copies, so the ones it took can go, even after leaving. */
  const clear = (ids: ReadonlyArray<string>) => {
    for (const item of files.get(group)) if (ids.includes(item.id)) release(item, true);
    setItems((list) => list.filter((item) => !ids.includes(item.id)));
  };

  const ready = items.flatMap((item) => (item.attachment === null ? [] : [item.attachment]));
  return {
    items,
    add,
    remove,
    retry,
    clear,
    ready,
    /** Something is still uploading or failed: sending now would drop it. */
    unsettled: items.some((item) => item.attachment === null),
    full: all.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  };
}
