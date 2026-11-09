import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type { AssetResource, ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { FileIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { downloadMedia } from "../media/mediaContent";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { GroupAttachmentItem } from "./useGroupAttachments";

const CHIP_CLASS =
  "relative flex h-12 max-w-52 min-w-0 items-center gap-2 rounded-lg border border-foreground/12 bg-foreground/4 ps-1.5 pe-7 text-xs";

/** What is waiting to be sent: a chip per file with its upload state and a way to drop it. */
export function GroupAttachmentChips(props: {
  readonly items: ReadonlyArray<GroupAttachmentItem>;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <ul data-testid="group-attachment-chips" className="flex flex-wrap gap-1.5">
      {props.items.map((item) => {
        const percent = Math.round(item.progress * 100);
        const uploading = item.attachment === null && item.error === null;
        return (
          <li key={item.id} data-testid="group-attachment-chip" className={CHIP_CLASS}>
            {item.previewUrl ? (
              <img
                src={item.previewUrl}
                alt=""
                draggable={false}
                className="size-9 shrink-0 rounded-md object-cover"
              />
            ) : (
              <FileIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
            )}
            <span className="grid min-w-0">
              <span className="truncate font-medium">{item.file.name || "Pasted file"}</span>
              {item.error === null ? (
                <span className="text-muted-foreground tabular-nums">
                  {uploading ? `Uploading ${percent}%` : formatAttachmentSize(item.file.size)}
                </span>
              ) : (
                <span role="alert" className="truncate text-destructive-foreground">
                  {item.error}
                </span>
              )}
            </span>
            {item.error === null ? null : (
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={`Retry ${item.file.name || "file"}`}
                onClick={() => props.onRetry(item.id)}
              >
                <RotateCcwIcon />
              </Button>
            )}
            <Button
              size="icon-micro"
              variant="ghost-muted"
              className="absolute end-1 top-1"
              aria-label={`Remove ${item.file.name || "file"}`}
              onClick={() => props.onRemove(item.id)}
            >
              <XIcon />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

const download = (url: string, name: string) =>
  downloadMedia(url, name).catch((cause: unknown) =>
    toastManager.add({
      type: "error",
      title: "Could not download",
      description: cause instanceof Error ? cause.message : String(cause),
    }),
  );

const resourceOf = (attachment: ChatAttachment): AssetResource => ({
  _tag: "attachment",
  attachmentId: attachment.id,
  fileName: attachment.name,
  mimeType: attachment.mimeType,
});

/** A sent message's files: image thumbnails that open the viewer, other files as download chips. */
export function GroupMessageAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly align: "start" | "end";
}) {
  const { environmentId, attachments } = props;
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const urls = useAssetUrls(environmentId, attachments.map(resourceOf));
  if (attachments.length === 0) return null;
  const images = attachments.flatMap((attachment, index) =>
    attachment.type === "image" ? [{ attachment, url: urls[index] ?? null }] : [],
  );
  const open = (id: string) =>
    setPreview({
      index: Math.max(
        images.findIndex((entry) => entry.attachment.id === id),
        0,
      ),
      images: images.map(({ attachment, url }) => ({
        src: url,
        name: attachment.name,
        mimeType: attachment.mimeType,
        actionsSource: {
          kind: "image",
          name: attachment.name,
          src: url,
          asset: { environmentId, resource: resourceOf(attachment) },
        },
      })),
    });
  return (
    <ul
      data-testid="group-message-attachments"
      className={cn("flex max-w-[85%] flex-wrap gap-1.5", props.align === "end" && "justify-end")}
    >
      {attachments.map((attachment, index) => {
        const url = urls[index] ?? null;
        return (
          <li key={attachment.id}>
            {attachment.type === "image" ? (
              <button
                type="button"
                aria-label={`Preview ${attachment.name}`}
                onClick={() => open(attachment.id)}
                className="flex size-24 cursor-zoom-in items-center justify-center overflow-hidden rounded-lg border border-foreground/12 bg-foreground/4 outline-none hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {url === null ? null : (
                  <img
                    src={url}
                    alt={attachment.name}
                    draggable={false}
                    className="size-full object-cover"
                  />
                )}
              </button>
            ) : (
              <button
                type="button"
                aria-label={`Download ${attachment.name}`}
                disabled={url === null}
                onClick={() => url !== null && void download(url, attachment.name)}
                className={cn(
                  CHIP_CLASS,
                  "cursor-pointer pe-3 outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                )}
              >
                <FileIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span className="grid min-w-0 text-start">
                  <span className="truncate font-medium">{attachment.name}</span>
                  <span className="text-muted-foreground">
                    {formatAttachmentSize(attachment.sizeBytes)}
                  </span>
                </span>
              </button>
            )}
          </li>
        );
      })}
      {preview ? <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} /> : null}
    </ul>
  );
}
