import type { MenuAction } from "@react-native-menu/menu";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type {
  AssetResource,
  EnvironmentId,
  KanbanCard,
  KanbanCardAttachment,
} from "@t3tools/contracts";
import { Image } from "expo-image";
import { Pressable, View } from "react-native";

import type { FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
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

type AttachmentId = KanbanCardAttachment["attachmentId"];
type AttachmentPatch = {
  readonly removeAttachmentIds?: readonly AttachmentId[];
  readonly coverAttachmentId?: AttachmentId | null;
};

export function kanbanAttachmentMenuActions(image: boolean, cover: boolean): MenuAction[] {
  return [
    ...(image
      ? [
          cover
            ? { id: "uncover", title: "Remove cover", image: "rectangle.slash" }
            : { id: "cover", title: "Make cover", image: "photo" },
        ]
      : []),
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
}

function AttachmentMenu(props: {
  readonly attachment: KanbanCardAttachment;
  readonly cover: boolean;
  readonly onPatch: (patch: AttachmentPatch) => void;
}) {
  const { attachment } = props;
  const run = (id: string) => {
    if (id === "cover") props.onPatch({ coverAttachmentId: attachment.attachmentId });
    else if (id === "uncover") props.onPatch({ coverAttachmentId: null });
    else if (id === "delete")
      Dialog.confirm({
        title: `Delete ${attachment.name}?`,
        message: "The file is removed from this card for good.",
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => props.onPatch({ removeAttachmentIds: [attachment.attachmentId] }),
      });
  };
  return (
    <Menu
      actions={kanbanAttachmentMenuActions(isImage(attachment), props.cover)}
      onPressAction={({ nativeEvent }) => run(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${attachment.name} actions`}
        hitSlop={8}
        className="size-9 items-center justify-center rounded-full active:opacity-70"
      >
        <SymbolView
          name="ellipsis"
          size={18}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

export function KanbanCardAttachmentList(props: {
  readonly environmentId: EnvironmentId;
  readonly card: KanbanCard;
  readonly onPress: (source: FilePreviewSource) => void;
  /** Absent on read-only connections. */
  readonly onPatch?: (patch: AttachmentPatch) => void;
}) {
  return (
    <View className="gap-3">
      {props.card.attachments.map((attachment) => {
        const cover = props.card.coverAttachmentId === attachment.attachmentId;
        return (
          <View key={attachment.attachmentId} className="flex-row items-center gap-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${attachment.name}`}
              onPress={() => props.onPress(previewOf(props.environmentId, attachment))}
              className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70"
            >
              <Thumbnail environmentId={props.environmentId} attachment={attachment} />
              <View className="min-w-0 flex-1 gap-0.5">
                <Text textRole="body" numberOfLines={1} className="font-t3-medium text-foreground">
                  {attachment.name}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {cover ? "Cover · " : ""}
                  Added {relativeTime(attachment.addedAt)} ago ·{" "}
                  {formatAttachmentSize(attachment.sizeBytes)}
                </Text>
              </View>
            </Pressable>
            {props.onPatch ? (
              <AttachmentMenu attachment={attachment} cover={cover} onPatch={props.onPatch} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
