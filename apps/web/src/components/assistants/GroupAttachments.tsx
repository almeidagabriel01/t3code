import { filePreviewKind } from "@t3tools/shared/filePreview";
import type { AssetResource, ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { selectMessageImageResources } from "../../session-logic";
import {
  type ChatFileAttachment,
  isFileAttachment,
  isImageAttachment,
  isVideoAttachment,
} from "../../types";
import { ComposerFilePreviewDialog } from "../chat/ComposerAttachmentStrip";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { UserFileCard, UserMessageMediaBlock } from "../chat/UserMessageAttachments";
import { InlineAudioPreview } from "../files/InlineAudioPreview";
import { downloadMedia } from "../media/mediaContent";
import { toastManager } from "../ui/toast";

const download = (url: string, name: string) =>
  downloadMedia(url, name).catch((cause: unknown) =>
    toastManager.add({
      type: "error",
      title: "Could not download",
      description: cause instanceof Error ? cause.message : String(cause),
    }),
  );

const fileResource = (file: ChatFileAttachment): AssetResource => ({
  _tag: "attachment",
  attachmentId: file.id,
  fileName: file.name,
  mimeType: file.mimeType,
});

/** A sent message's files, drawn by the thread timeline's own media block and file cards. */
export function GroupMessageAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly align: "start" | "end";
}) {
  const { environmentId, attachments } = props;
  const resolvedTheme = useRenderedAppearance();
  const [expanded, setExpanded] = useState<ExpandedImagePreview | null>(null);
  const [opened, setOpened] = useState<ChatFileAttachment | null>(null);
  const imageResources = selectMessageImageResources(attachments);
  const imageUrls = useAssetUrls(environmentId, imageResources);
  const files = attachments.filter(isFileAttachment);
  const fileUrls = useAssetUrls(environmentId, files.map(fileResource));
  if (attachments.length === 0) return null;
  const urlById = new Map(
    imageResources.flatMap((resource, index) => {
      const url = imageUrls[index];
      return url ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const images = attachments.filter(isImageAttachment).map((image) => {
    const previewUrl = urlById.get(image.id);
    return previewUrl === undefined ? image : { ...image, previewUrl };
  });
  const videos = files.filter(isVideoAttachment);
  const audio = files.filter((file) => filePreviewKind(file) === "audio");
  const cards = files.filter((file) => !isVideoAttachment(file) && !audio.includes(file));
  const onDownload = (file: ChatFileAttachment) => {
    const url = fileUrls[files.indexOf(file)];
    if (url) void download(url, file.name);
  };
  return (
    <div
      data-testid="group-message-attachments"
      className={cn(
        "flex max-w-[85%] flex-col gap-1 @xl/group-chat:max-w-[75%]",
        props.align === "end" ? "items-end" : "items-start",
      )}
    >
      <UserMessageMediaBlock
        images={images}
        videos={videos}
        standalone
        cornerClassName=""
        environmentId={environmentId}
        onImageExpand={setExpanded}
      />
      {audio.map((file) => (
        <InlineAudioPreview
          key={file.id}
          name={file.name}
          variant="bubble"
          environmentId={environmentId}
          resource={{
            _tag: "attachment",
            attachmentId: file.id,
            fileName: file.name,
            mimeType: file.mimeType,
            disposition: "inline",
          }}
          onOpen={() => setOpened(file)}
        />
      ))}
      {cards.map((file) => (
        <UserFileCard
          key={file.id}
          file={file}
          copyMarkdown={undefined}
          resolvedTheme={resolvedTheme}
          onOpen={setOpened}
          onDownload={onDownload}
        />
      ))}
      {expanded ? (
        <ExpandedImageDialog preview={expanded} onClose={() => setExpanded(null)} />
      ) : null}
      {opened ? (
        <ComposerFilePreviewDialog
          file={{
            ...opened,
            file: null,
            uploadedAttachmentId: opened.id,
            uploadEnvironmentId: environmentId,
          }}
          origin="Attachment"
          onPreviewFileIdChange={(id) => id === null && setOpened(null)}
        />
      ) : null}
    </div>
  );
}
