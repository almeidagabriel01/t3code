import type { EnvironmentId } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";

import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { formatBytes } from "../../lib/formatBytes";
import type { ChatFileAttachment, ChatImageAttachment } from "../../types";
import { cn } from "~/lib/utils";
import { AttachmentImage } from "../media/AttachmentImage";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildAttachmentVideoAsset,
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { PierreEntryIcon } from "./PierreEntryIcon";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import { userMessageFileLabel } from "./TimelineUserMessageRow.logic";

// Drawn inside the media so dark screenshots keep an edge on the dark background.
const MEDIA_EDGE_CLASS_NAME =
  "relative after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-black/9 dark:after:ring-white/12";

/** A sent file as a card that previews on click and downloads from its button. */
export function UserFileCard({
  file,
  copyMarkdown,
  resolvedTheme,
  onOpen,
  onDownload,
}: {
  readonly file: ChatFileAttachment;
  readonly copyMarkdown: string | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly onOpen: (file: ChatFileAttachment) => void;
  readonly onDownload: (file: ChatFileAttachment) => void;
}) {
  const pastedText = file.source?._tag === "pasted-text";
  const label = userMessageFileLabel(file);
  const extension = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toUpperCase() ?? "File";
  const identity = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/60">
        <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium group-hover/file:underline">
          {label}
        </span>
        <span className="block text-xs text-muted-foreground tabular-nums">
          {file.downloadable === false ? (
            "Sending…"
          ) : (
            <>
              {!pastedText && `${extension} · `}
              {formatBytes(file.sizeBytes)}
            </>
          )}
        </span>
      </span>
    </>
  );
  return (
    <div
      data-markdown-copy={copyMarkdown}
      className="flex w-64 max-w-full items-center gap-1 rounded-2xl bg-message py-2 ps-2 pe-1 text-message-foreground"
    >
      {file.downloadable === false ? (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-3">{identity}</div>
          <Button size="icon-xs" variant="ghost-muted" disabled aria-label="Sending attachment">
            <DownloadIcon />
          </Button>
        </>
      ) : (
        <>
          <button
            type="button"
            aria-label={`Preview ${label}`}
            onClick={() => onOpen(file)}
            className="group/file focus-visible:ring-ring/70 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
          >
            {identity}
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Download ${label}`}
                  onClick={() => onDownload(file)}
                />
              }
            >
              <DownloadIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Download {label}</TooltipPopup>
          </Tooltip>
        </>
      )}
    </div>
  );
}

function UserVideoAttachment({
  file,
  environmentId,
  onImageExpand,
  standalone = false,
  cornerClassName,
}: {
  readonly file: ChatFileAttachment;
  readonly environmentId: EnvironmentId;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly standalone?: boolean;
  readonly cornerClassName?: string | undefined;
}) {
  // Row updates rebuild attachment objects, so the asset follows only the
  // fields it reads.
  const { downloadable, id, mimeType, name } = file;
  const asset =
    downloadable === false
      ? null
      : buildAttachmentVideoAsset(environmentId, { id, mimeType, name });
  const resource = asset?.resource ?? null;
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(environmentId, resource);
  const src = assetUrl._tag === "Success" ? assetUrl.url : (file.previewUrl ?? null);

  if (asset === null && src === null) {
    return (
      <div
        className={cn(
          "flex aspect-[4/3] w-full items-center justify-center bg-black px-2 py-3 text-center text-2xs text-white/70",
          standalone
            ? cn(MEDIA_EDGE_CLASS_NAME, "rounded-2xl", cornerClassName)
            : "rounded-lg border border-border/80",
        )}
      >
        {file.name}
      </div>
    );
  }

  const player = (
    <MediaVideoPlayer
      src={src}
      sourceFailed={
        file.previewUrl === undefined && resource !== null && assetUrl._tag === "Failure"
      }
      label={file.name}
      preload="visible"
      onOpen={() => {
        const preview = buildAttachmentVideoPreview(environmentId, file);
        if (preview) onImageExpand(preview);
      }}
      className="block aspect-[4/3] w-full"
      videoClassName={cn(
        "aspect-auto size-full",
        !standalone && "rounded-lg border border-border/80",
      )}
      stateClassName={cn(
        "aspect-auto min-h-full bg-black text-white",
        !standalone && "rounded-lg border border-border/80",
      )}
      onRetry={asset ? refreshAssetUrl : undefined}
      actionsSource={asset ? { kind: "video", name: file.name, src, asset } : undefined}
    />
  );
  return standalone ? (
    <div className={cn(MEDIA_EDGE_CLASS_NAME, "overflow-hidden rounded-2xl", cornerClassName)}>
      {player}
    </div>
  ) : (
    player
  );
}

/**
 * A sent message's images and videos: a 2-column grid inside the bubble, or, when `standalone`, its
 * own shape beside the bubble (one image keeps its aspect, several share a collage).
 */
export function UserMessageMediaBlock({
  images,
  videos,
  standalone,
  cornerClassName,
  environmentId,
  onImageExpand,
}: {
  readonly images: ReadonlyArray<ChatImageAttachment>;
  readonly videos: ReadonlyArray<ChatFileAttachment>;
  readonly standalone: boolean;
  /** Corners that touch the bubble or a neighbouring message tighten, like the bubble's. */
  readonly cornerClassName: string;
  readonly environmentId: EnvironmentId;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  if (images.length === 0 && videos.length === 0) return null;
  // A lone image keeps its own shape; a 4:3 crop hides most of a wide screenshot.
  const loneImage = standalone && videos.length === 0 && images.length === 1;
  // Several images share one rounded shape, split by hairlines.
  const collage =
    standalone &&
    videos.length === 0 &&
    images.length > 1 &&
    images.every((image) => image.source?.kind !== "snap-shot");
  return (
    <div
      className={cn(
        "grid",
        !standalone
          ? "mb-2 max-w-[210px] grid-cols-2 gap-2"
          : loneImage
            ? "max-w-full"
            : collage
              ? cn(
                  MEDIA_EDGE_CLASS_NAME,
                  "w-80 max-w-full gap-px overflow-hidden rounded-2xl bg-black/9 dark:bg-white/12",
                  cornerClassName,
                  images.length === 2
                    ? "auto-rows-[12rem] grid-cols-2"
                    : images.length === 3
                      ? "auto-rows-[calc(6rem-0.5px)] grid-cols-[3fr_2fr]"
                      : "auto-rows-[6rem] grid-cols-2",
                )
              : images.length + videos.length === 1
                ? "w-80 max-w-full"
                : "w-80 max-w-full grid-cols-2 gap-2",
      )}
    >
      {images.map((image, index) => (
        <div
          key={image.id}
          className={cn(
            "bg-background/70",
            image.source?.kind === "snap-shot" && image.previewUrl
              ? cn(
                  "col-span-2",
                  standalone
                    ? cn(
                        MEDIA_EDGE_CLASS_NAME,
                        "min-h-16 justify-self-end overflow-hidden rounded-2xl",
                        loneImage && cornerClassName,
                      )
                    : SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
                )
              : loneImage
                ? cn(MEDIA_EDGE_CLASS_NAME, "overflow-hidden rounded-2xl", cornerClassName)
                : collage
                  ? cn(
                      "overflow-hidden bg-background",
                      images.length === 3 && index === 0 && "row-span-2",
                      images.length > 3 &&
                        images.length % 2 === 1 &&
                        index === images.length - 1 &&
                        "col-span-2",
                    )
                  : standalone
                    ? cn(MEDIA_EDGE_CLASS_NAME, "aspect-[4/3] overflow-hidden rounded-2xl")
                    : "aspect-[4/3] overflow-hidden rounded-lg border border-border/80",
          )}
        >
          {image.previewUrl ? (
            <button
              type="button"
              className="block h-full w-full cursor-zoom-in"
              aria-label={`Preview ${image.name}`}
              onClick={() => {
                const preview = buildExpandedImagePreview(images, image.id);
                if (!preview) return;
                onImageExpand(preview);
              }}
            >
              {/* Isolate the thumbnail raster from nearby activity repaints in Chromium. */}
              <AttachmentImage
                name={image.name}
                mimeType={image.mimeType}
                src={image.previewUrl}
                alt={image.name}
                decoding="async"
                loading="lazy"
                className={cn(
                  "block transform-gpu",
                  standalone && image.source?.kind === "snap-shot"
                    ? "h-auto max-h-48 w-auto min-w-24 max-w-full object-contain"
                    : loneImage
                      ? "h-48 w-auto min-w-24 max-w-full object-cover"
                      : "size-full object-cover",
                )}
              />
            </button>
          ) : (
            <div
              className={cn(
                "flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-2xs text-muted-foreground/70",
                loneImage && "h-48 w-64 max-w-full",
                collage && "h-full",
              )}
            >
              {image.name}
            </div>
          )}
          {image.previewUrl && image.source?.kind === "snap-shot" ? (
            <SnapShotAttachmentDetails source={image.source} />
          ) : null}
        </div>
      ))}
      {videos.map((file) => (
        <UserVideoAttachment
          key={file.id}
          file={file}
          environmentId={environmentId}
          onImageExpand={onImageExpand}
          standalone={standalone}
          cornerClassName={images.length + videos.length === 1 ? cornerClassName : undefined}
        />
      ))}
    </div>
  );
}
