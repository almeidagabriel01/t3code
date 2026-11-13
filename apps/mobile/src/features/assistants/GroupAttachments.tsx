import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type AssetResource,
  type ChatAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, View } from "react-native";

import type { FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { assetImageSource } from "../../lib/assetImageSource";
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
import { useAssetUrl } from "../../state/assets";

export interface GroupAttachmentItem {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
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
    throw new Error(`Upload failed for '${item.name}'.`);
  }
  return {
    type: uploaded.type,
    id: uploaded.id,
    name: uploaded.name,
    mimeType: uploaded.mimeType,
    sizeBytes: uploaded.sizeBytes,
  };
}

/**
 * Files the user attaches to one group message, from the same picker as the thread composer. Each
 * uploads on its own, so one that fails keeps its chip (retry or remove) and never costs the others.
 */
export function useGroupAttachments(environmentId: EnvironmentId) {
  const [items, setItems] = useState<ReadonlyArray<GroupAttachmentItem>>([]);

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
      name: source.name,
      sizeBytes: source.sizeBytes,
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
    const picked = await pickComposerFiles({ existingCount: items.length });
    add(picked.files);
    return picked.error;
  };

  /** Opens the photo library; same contract as `pick`. */
  const pickMedia = async (): Promise<string | null> => {
    const picked = await pickComposerMedia({ existingCount: items.length });
    add(picked.attachments);
    return picked.error;
  };

  /** Images pasted into the editor. */
  const paste = async (uris: ReadonlyArray<string>) => {
    add(await convertPastedImagesToAttachments({ uris, existingCount: items.length }));
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

  /** After a send the server holds its own copies, so the pending ones can go. */
  const clear = () => {
    release(items.map((item) => item.attachment));
    setItems([]);
  };

  return {
    items,
    pick,
    pickMedia,
    paste,
    remove,
    retry,
    clear,
    ready: items.flatMap((item) => (item.attachment === null ? [] : [item.attachment])),
    /** Something is still uploading or failed: sending now would drop it. */
    unsettled: items.some((item) => item.attachment === null),
    full: items.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  };
}

/** What is waiting to be sent: a chip per file with its upload state and a way to drop it. */
export function GroupAttachmentChips(props: {
  readonly items: ReadonlyArray<GroupAttachmentItem>;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <View testID="group-attachment-chips" className="flex-row flex-wrap gap-1.5">
      {props.items.map((item) => (
        <View
          key={item.id}
          testID="group-attachment-chip"
          className="max-w-56 flex-row items-center gap-1.5 rounded-xl border border-border px-2 py-1.5"
        >
          <SymbolView
            name={item.source.type === "image" ? "photo" : "doc"}
            size={16}
            tintColorClassName="accent-icon-subtle"
          />
          <View className="min-w-0 shrink gap-0.5">
            <Text className="text-xs font-t3-medium text-foreground" numberOfLines={1}>
              {item.name}
            </Text>
            {item.error === null ? (
              <Text className="text-xs text-foreground-muted">
                {item.attachment === null
                  ? `Uploading ${Math.round(item.progress * 100)}%`
                  : formatAttachmentSize(item.sizeBytes)}
              </Text>
            ) : (
              <Text
                accessibilityRole="alert"
                className="text-xs text-danger-foreground"
                numberOfLines={2}
              >
                {item.error}
              </Text>
            )}
          </View>
          {item.error === null ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Retry ${item.name}`}
              hitSlop={8}
              onPress={() => props.onRetry(item.id)}
              className="active:opacity-70"
            >
              <SymbolView
                name="arrow.clockwise"
                size={16}
                tintColorClassName="accent-icon-subtle"
              />
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.name}`}
            hitSlop={8}
            onPress={() => props.onRemove(item.id)}
            className="active:opacity-70"
          >
            <SymbolView
              name="xmark.circle.fill"
              size={16}
              tintColorClassName="accent-icon-subtle"
            />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const resourceOf = (attachment: ChatAttachment): AssetResource => ({
  _tag: "attachment",
  attachmentId: attachment.id,
  fileName: attachment.name,
  mimeType: attachment.mimeType,
  ...(attachment.type === "image" || attachment.mimeType === "application/pdf"
    ? { disposition: "inline" as const }
    : {}),
});

const previewOf = (
  environmentId: EnvironmentId,
  attachment: ChatAttachment,
): FilePreviewSource => ({
  kind:
    attachment.type === "image"
      ? "image"
      : attachment.mimeType === "application/pdf"
        ? "pdf"
        : "document",
  name: attachment.name,
  mimeType: attachment.mimeType,
  environmentId,
  resource: resourceOf(attachment),
});

function Thumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
}) {
  const resource = resourceOf(props.attachment);
  const url = useAssetUrl(props.environmentId, resource);
  return url === null ? null : (
    <Image
      source={assetImageSource(props.environmentId, resource, url)}
      cachePolicy="memory-disk"
      contentFit="cover"
      style={{ width: "100%", height: "100%" }}
      accessibilityIgnoresInvertColors
    />
  );
}

/** A sent message's files: image thumbnails and file chips, each opening the file preview. */
export function GroupMessageAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly onPreview: (source: FilePreviewSource) => void;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <View testID="group-message-attachments" className="max-w-[85%] flex-row flex-wrap gap-1.5">
      {props.attachments.map((attachment) => (
        <Pressable
          key={attachment.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${attachment.name}`}
          onPress={() => props.onPreview(previewOf(props.environmentId, attachment))}
          className={
            attachment.type === "image"
              ? "size-24 overflow-hidden rounded-xl bg-secondary active:opacity-80"
              : "max-w-56 flex-row items-center gap-1.5 rounded-xl border border-border px-2 py-1.5 active:opacity-70"
          }
        >
          {attachment.type === "image" ? (
            <Thumbnail environmentId={props.environmentId} attachment={attachment} />
          ) : (
            <>
              <SymbolView name="doc" size={16} tintColorClassName="accent-icon-subtle" />
              <View className="min-w-0 shrink gap-0.5">
                <Text className="text-xs font-t3-medium text-foreground" numberOfLines={1}>
                  {attachment.name}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {formatAttachmentSize(attachment.sizeBytes)}
                </Text>
              </View>
            </>
          )}
        </Pressable>
      ))}
    </View>
  );
}
