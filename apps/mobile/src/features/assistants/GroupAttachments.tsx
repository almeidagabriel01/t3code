import { createAssistantGroupFileStore } from "@t3tools/client-runtime/assistantGroupChat";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { ComposerAttachmentOwnUploads } from "../../components/ComposerAttachmentStrip";
import type { ComposerAttachmentUploadState } from "../../lib/composerAttachmentUploadQueue";
import {
  prepareTurnAttachments,
  releasePendingAttachmentUploads,
} from "../../lib/attachmentUpload";
import {
  convertPastedImagesToAttachments,
  pickComposerFiles,
  pickComposerMedia,
  type DraftComposerAttachment,
} from "../../lib/composerImages";

export interface GroupAttachmentItem {
  readonly id: string;
  readonly source: DraftComposerAttachment;
  readonly progress: number;
  readonly error: string | null;
  /** Set once the upload finished: what the post sends. */
  readonly attachment: ChatAttachment | null;
}

/** Uploads one picked file to the server's pending area and returns the record a post sends. */
async function uploadOne(
  environmentId: EnvironmentId,
  item: GroupAttachmentItem,
  onProgress: (progress: number) => void,
): Promise<ChatAttachment> {
  const prepared = await prepareTurnAttachments({
    environmentId,
    attachments: [item.source],
    supportsImageUploads: true,
    onUploadProgress: (_, progress) => onProgress(progress),
  });
  const uploaded = prepared.status === "ready" ? prepared.attachments[0] : undefined;
  if (
    uploaded === undefined ||
    !("id" in uploaded) ||
    uploaded.id === undefined ||
    (uploaded.type !== "image" && uploaded.type !== "file")
  ) {
    throw new Error(`Upload failed for '${item.source.name}'.`);
  }
  return {
    type: uploaded.type,
    id: uploaded.id,
    name: uploaded.name,
    mimeType: uploaded.mimeType,
    sizeBytes: uploaded.sizeBytes,
  };
}

const files = createAssistantGroupFileStore<GroupAttachmentItem>();

/** For tests: each starts with no files. */
export const clearGroupAttachments = () => files.clear();

/**
 * Files the user attaches to one group message, from the same picker as the thread composer. Each
 * uploads on its own, so one that fails keeps its chip (retry or remove) and never costs the others.
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
  const setItems = (
    change: (list: ReadonlyArray<GroupAttachmentItem>) => ReadonlyArray<GroupAttachmentItem>,
  ) => files.update(group, change);
  const items = all.filter((item) => !held.has(item.id));
  const latestPending = useRef(pending);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the unmount cleanup below reads the pending files as of the last commit
  useEffect(() => {
    latestPending.current = pending;
  });

  const update = (id: string, change: Partial<GroupAttachmentItem>) =>
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));

  const run = async (item: GroupAttachmentItem) => {
    try {
      const attachment = await uploadOne(environmentId, item, (progress) =>
        update(item.id, { progress }),
      );
      update(item.id, { progress: 1, attachment });
    } catch (cause) {
      update(item.id, { error: cause instanceof Error ? cause.message : "Upload failed." });
    }
  };

  const release = (attachments: ReadonlyArray<ChatAttachment | null>) => {
    const ids = attachments.flatMap((attachment) => (attachment === null ? [] : [attachment.id]));
    if (ids.length > 0) void releasePendingAttachmentUploads(environmentId, ids).catch(() => {});
  };

  const add = (sources: ReadonlyArray<DraftComposerAttachment>) => {
    const added = sources.map((source): GroupAttachmentItem => ({
      id: source.id,
      source,
      progress: 0,
      error: null,
      attachment: null,
    }));
    setItems((list) => [...list, ...added]);
    for (const item of added) void run(item);
  };

  /** Opens the file picker; returns what to tell the user when it could not take every file. */
  const pick = async (): Promise<string | null> => {
    const picked = await pickComposerFiles({ existingCount: all.length });
    add(picked.files);
    return picked.error;
  };

  /** Opens the photo library; same contract as `pick`. */
  const pickMedia = async (): Promise<string | null> => {
    const picked = await pickComposerMedia({ existingCount: all.length });
    add(picked.attachments);
    return picked.error;
  };

  /** Images pasted into the editor. */
  const paste = async (uris: ReadonlyArray<string>) => {
    add(await convertPastedImagesToAttachments({ uris, existingCount: all.length }));
  };

  const remove = (id: string) => {
    release([items.find((item) => item.id === id)?.attachment ?? null]);
    setItems((list) => list.filter((item) => item.id !== id));
  };

  const retry = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    if (item === undefined) return;
    const reset = { ...item, progress: 0, error: null };
    update(id, reset);
    void run(reset);
  };

  // Leaving the chat drops what was never sent; its pending uploads are ours.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases pending uploads on unmount
  useEffect(
    () => () => {
      const ids = files
        .leave(group, latestPending.current)
        .flatMap((item) => (item.attachment === null ? [] : [item.attachment.id]));
      if (ids.length > 0) void releasePendingAttachmentUploads(environmentId, ids).catch(() => {});
    },
    [group, environmentId],
  );

  /** After a send the server holds its own copies, so the ones it took can go, even after leaving. */
  const clear = (ids: ReadonlyArray<string>) => {
    release(files.get(group).flatMap((item) => (ids.includes(item.id) ? [item.attachment] : [])));
    setItems((list) => list.filter((item) => !ids.includes(item.id)));
  };

  /** The thread composer's strip shows these uploads with its own progress and retry. */
  const uploads: ComposerAttachmentOwnUploads = {
    stateOf: (id) => {
      const item = items.find((entry) => entry.id === id);
      return item === undefined ? undefined : groupAttachmentUploadState(item);
    },
    retry,
  };

  return {
    items,
    uploads,
    pick,
    pickMedia,
    paste,
    remove,
    retry,
    clear,
    ready: items.flatMap((item) => (item.attachment === null ? [] : [item.attachment])),
    /** Something is still uploading or failed: sending now would drop it. */
    unsettled: items.some((item) => item.attachment === null),
    full: all.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  };
}

function groupAttachmentUploadState(item: GroupAttachmentItem): ComposerAttachmentUploadState {
  if (item.error !== null) return { status: "failed", reason: item.error };
  if (item.attachment === null) return { status: "uploading", progress: item.progress };
  return { status: "ready" };
}
