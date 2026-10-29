import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type {
  AssetResource,
  EnvironmentId,
  KanbanCard,
  KanbanCardAttachment,
} from "@t3tools/contracts";
import { Image } from "expo-image";
import { Pressable, View } from "react-native";

import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { AppText as Text } from "../../components/ui/AppText";
import { assetImageSource } from "../../lib/assetImageSource";
import { relativeTime } from "../../lib/time";
import { useAssetUrl } from "../../state/assets";

const isImage = (attachment: KanbanCardAttachment) => attachment.mimeType.startsWith("image/");

const resourceOf = (attachment: KanbanCardAttachment): AssetResource => ({
  _tag: "attachment",
  attachmentId: attachment.attachmentId,
  fileName: attachment.name,
  mimeType: attachment.mimeType,
  ...(isImage(attachment) || attachment.mimeType === "application/pdf"
    ? { disposition: "inline" as const }
    : {}),
});

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot >= name.length - 6 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

function previewOf(
  environmentId: EnvironmentId,
  attachment: KanbanCardAttachment,
): FilePreviewSource {
  return {
    kind: isImage(attachment)
      ? "image"
      : attachment.mimeType === "application/pdf"
        ? "pdf"
        : "document",
    name: attachment.name,
    mimeType: attachment.mimeType,
    environmentId,
    resource: resourceOf(attachment),
  };
}

function Thumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: KanbanCardAttachment;
}) {
  const image = isImage(props.attachment);
  const resource = resourceOf(props.attachment);
  const url = useAssetUrl(props.environmentId, image ? resource : null);
  return (
    <View className="h-16 w-24 items-center justify-center overflow-hidden rounded-xl bg-secondary">
      {image && url !== null ? (
        <Image
          source={assetImageSource(props.environmentId, resource, url)}
          cachePolicy="memory-disk"
          contentFit="cover"
          style={{ width: "100%", height: "100%" }}
          accessibilityIgnoresInvertColors
        />
      ) : image ? null : (
        <Text textRole="caption" className="font-t3-bold text-foreground-muted">
          {extensionOf(props.attachment.name)}
        </Text>
      )}
    </View>
  );
}

export function KanbanCardCoverImage(props: {
  readonly environmentId: EnvironmentId;
  readonly card: KanbanCard;
  readonly onPress: (source: FilePreviewSource) => void;
}) {
  const attachment = props.card.attachments.find(
    (entry) => entry.attachmentId === props.card.coverAttachmentId,
  );
  const resource = attachment ? resourceOf(attachment) : null;
  const url = useAssetUrl(props.environmentId, resource);
  if (attachment === undefined || resource === null || url === null) return null;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Cover, ${attachment.name}`}
      onPress={() => props.onPress(previewOf(props.environmentId, attachment))}
      className="overflow-hidden rounded-2xl bg-secondary active:opacity-80"
    >
      <Image
        source={assetImageSource(props.environmentId, resource, url)}
        cachePolicy="memory-disk"
        contentFit="cover"
        style={{ width: "100%", height: 160 }}
        accessibilityIgnoresInvertColors
      />
    </Pressable>
  );
}

export function KanbanCardAttachmentList(props: {
  readonly environmentId: EnvironmentId;
  readonly card: KanbanCard;
  readonly onPress: (source: FilePreviewSource) => void;
}) {
  return (
    <View className="gap-3">
      {props.card.attachments.map((attachment) => (
        <Pressable
          key={attachment.attachmentId}
          accessibilityRole="button"
          accessibilityLabel={`Open ${attachment.name}`}
          onPress={() => props.onPress(previewOf(props.environmentId, attachment))}
          className="flex-row items-center gap-3 active:opacity-70"
        >
          <Thumbnail environmentId={props.environmentId} attachment={attachment} />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text textRole="body" numberOfLines={1} className="font-t3-medium text-foreground">
              {attachment.name}
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {props.card.coverAttachmentId === attachment.attachmentId ? "Cover · " : ""}
              Added {relativeTime(attachment.addedAt)} ago ·{" "}
              {formatAttachmentSize(attachment.sizeBytes)}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}
