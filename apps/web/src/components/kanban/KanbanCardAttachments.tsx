import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type {
  AssetResource,
  EnvironmentId,
  KanbanCard,
  KanbanCardAttachment,
  KanbanCardUpdateInput,
} from "@t3tools/contracts";
import {
  DownloadIcon,
  ImageIcon,
  ImageOffIcon,
  PaperclipIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useAssetUrls, useAssetUrlState } from "../../assets/assetUrls";
import { requestConfirmDialog } from "../../confirmDialog";
import { uploadStandaloneAttachment } from "../../lib/attachmentUploadQueue";
import { randomUUID } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { downloadMedia } from "../media/mediaContent";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SectionHeading } from "./kanbanPresentation";

type Patch = (
  input: Omit<KanbanCardUpdateInput, "commandId" | "actor" | "cardId">,
) => Promise<unknown>;

interface PendingUpload {
  readonly id: string;
  readonly file: File;
  /** Object URL for images, revoked when the upload leaves the list. */
  readonly previewUrl: string | null;
  readonly progress: number;
  readonly error: string | null;
}

const isImage = (mimeType: string) => mimeType.startsWith("image/");

const attachmentResource = (attachment: KanbanCardAttachment): AssetResource => ({
  _tag: "attachment",
  attachmentId: attachment.attachmentId,
  fileName: attachment.name,
  mimeType: attachment.mimeType,
});

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot >= name.length - 6 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

/** Pasted, dropped, and picked files upload with a local preview, then join the card at once. */
export function useCardAttachmentUploads(input: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly patch: Patch;
}) {
  const [uploads, setUploads] = useState<ReadonlyArray<PendingUpload>>([]);
  const [dragging, setDragging] = useState(false);
  const previewUrls = useRef(new Set<string>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- object URLs are browser resources the sheet must release when it closes
  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const update = (id: string, change: Partial<PendingUpload>) =>
    setUploads((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));

  const discard = (id: string) =>
    setUploads((list) => {
      const item = list.find((entry) => entry.id === id);
      if (item?.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
        previewUrls.current.delete(item.previewUrl);
      }
      return list.filter((entry) => entry.id !== id);
    });

  const run = async (item: PendingUpload) => {
    try {
      const uploaded = await uploadStandaloneAttachment(
        input.environmentId,
        item.file,
        (progress) => update(item.id, { progress }),
      );
      const added = await input.patch({
        addAttachments: [
          {
            attachmentId: uploaded.attachmentId,
            name: item.file.name || "file",
            mimeType: uploaded.mimeType,
            sizeBytes: item.file.size,
          },
        ],
      });
      if (added === null) update(item.id, { error: "The card could not keep this file." });
      else discard(item.id);
    } catch (cause) {
      update(item.id, { error: cause instanceof Error ? cause.message : "Upload failed" });
    }
  };

  const addFiles = (files: ReadonlyArray<File>) => {
    if (input.disabled || files.length === 0) return;
    const items = files.map((file): PendingUpload => {
      const previewUrl = isImage(file.type) ? URL.createObjectURL(file) : null;
      if (previewUrl) previewUrls.current.add(previewUrl);
      return { id: randomUUID(), file, previewUrl, progress: 0, error: null };
    });
    setUploads((list) => [...list, ...items]);
    for (const item of items) void run(item);
  };

  const retry = (id: string) => {
    const item = uploads.find((entry) => entry.id === id);
    if (item === undefined) return;
    const reset = { ...item, progress: 0, error: null };
    update(id, reset);
    void run(reset);
  };

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const dropHandlers = {
    onPaste: (event: ClipboardEvent) => {
      // The description editor claims its own pastes as inline images.
      if (event.defaultPrevented || input.disabled) return;
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    },
    onDragOver: (event: DragEvent) => {
      if (input.disabled || !hasFiles(event)) return;
      event.preventDefault();
      if (!dragging) setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      setDragging(false);
      if (event.defaultPrevented || input.disabled || !hasFiles(event)) return;
      event.preventDefault();
      addFiles(Array.from(event.dataTransfer.files));
    },
  };

  return { uploads, dragging, addFiles, retry, discard, dropHandlers };
}

export function KanbanAttachmentDropOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-background/85 text-sm font-medium text-foreground"
    >
      <PaperclipIcon className="size-6 text-primary" />
      Drop to attach
    </div>
  );
}

function Thumbnail(props: {
  readonly name: string;
  readonly src: string | null;
  readonly image: boolean;
  readonly label: string;
  readonly onOpen?: (() => void) | undefined;
  readonly children?: ReactNode;
}) {
  const body = props.image ? (
    props.src ? (
      <img src={props.src} alt={props.name} className="size-full object-cover" draggable={false} />
    ) : (
      <ImageIcon aria-hidden className="size-5 text-muted-foreground" />
    )
  ) : (
    <span className="rounded-md bg-background px-1.5 py-0.5 text-xs font-semibold tracking-wide text-muted-foreground shadow-xs/5">
      {extensionOf(props.name)}
    </span>
  );
  const className =
    "relative flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted";
  return props.onOpen ? (
    <button
      type="button"
      aria-label={props.label}
      onClick={props.onOpen}
      className={`${className} cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`}
    >
      {body}
      {props.children}
    </button>
  ) : (
    <div className={className}>
      {body}
      {props.children}
    </div>
  );
}

function UploadRow(props: {
  readonly upload: PendingUpload;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
}) {
  const { upload } = props;
  const percent = Math.round(upload.progress * 100);
  return (
    <li className="flex items-center gap-3" data-testid="kanban-attachment-upload">
      <Thumbnail
        name={upload.file.name}
        src={upload.previewUrl}
        image={upload.previewUrl !== null}
        label={upload.file.name}
      >
        {upload.error === null ? (
          <span
            role="progressbar"
            aria-label={`Uploading ${upload.file.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-black/30"
          >
            <span className="block h-full bg-white" style={{ width: `${percent}%` }} />
          </span>
        ) : null}
      </Thumbnail>
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="truncate text-sm font-medium">{upload.file.name || "Pasted file"}</span>
        {upload.error === null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            Uploading… {percent}% · {formatAttachmentSize(upload.file.size)}
          </span>
        ) : (
          <>
            <span role="alert" className="text-xs text-destructive-foreground">
              {upload.error}
            </span>
            <span className="flex gap-1">
              <Button size="xs" variant="outline" onClick={props.onRetry}>
                <RotateCcwIcon />
                Retry
              </Button>
              <Button size="xs" variant="ghost-muted" onClick={props.onDiscard}>
                <XIcon />
                Remove
              </Button>
            </span>
          </>
        )}
      </div>
    </li>
  );
}

function AttachmentRows(props: {
  readonly environmentId: EnvironmentId;
  readonly card: KanbanCard;
  readonly disabled: boolean;
  readonly patch: Patch;
}) {
  const { card, environmentId } = props;
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const urls = useAssetUrls(environmentId, card.attachments.map(attachmentResource));
  const images = card.attachments.flatMap((attachment, index) =>
    isImage(attachment.mimeType) ? [{ attachment, url: urls[index] ?? null }] : [],
  );

  const open = (attachmentId: string) => {
    const index = images.findIndex((entry) => entry.attachment.attachmentId === attachmentId);
    if (index < 0) return;
    setPreview({
      index,
      images: images.map(({ attachment, url }) => ({
        src: url,
        name: attachment.name,
        mimeType: attachment.mimeType,
        actionsSource: {
          kind: "image",
          name: attachment.name,
          src: url,
          asset: { environmentId, resource: attachmentResource(attachment) },
        },
      })),
    });
  };

  const download = async (attachment: KanbanCardAttachment, url: string | null) => {
    const failed = (description: string) =>
      toastManager.add({ type: "error", title: "Could not download", description });
    if (url === null) return failed("The file is not available yet.");
    try {
      await downloadMedia(url, attachment.name);
    } catch (cause) {
      failed(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = async (attachment: KanbanCardAttachment) => {
    const confirmed = await requestConfirmDialog(
      `Delete ${attachment.name}?\nThe file is removed from this card for good.`,
      { variant: "destructive" },
    );
    if (confirmed) void props.patch({ removeAttachmentIds: [attachment.attachmentId] });
  };

  return (
    <>
      {card.attachments.map((attachment, index) => {
        const url = urls[index] ?? null;
        const image = isImage(attachment.mimeType);
        const cover = card.coverAttachmentId === attachment.attachmentId;
        return (
          <li key={attachment.attachmentId} className="group flex items-center gap-3">
            <Thumbnail
              name={attachment.name}
              src={url}
              image={image}
              label={`Preview ${attachment.name}`}
              onOpen={image ? () => open(attachment.attachmentId) : undefined}
            />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{attachment.name}</span>
                {cover ? (
                  <span className="shrink-0 rounded-sm bg-muted px-1.5 text-2xs font-medium text-muted-foreground">
                    Cover
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                Added {formatRelativeTimeLabel(attachment.addedAt)} ·{" "}
                {formatAttachmentSize(attachment.sizeBytes)}
              </span>
              <span className="-ms-2 flex flex-wrap items-center">
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => void download(attachment, url)}
                >
                  <DownloadIcon />
                  Download
                </Button>
                {image && !props.disabled ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() =>
                      void props.patch({
                        coverAttachmentId: cover ? null : attachment.attachmentId,
                      })
                    }
                  >
                    {cover ? <ImageOffIcon /> : <ImageIcon />}
                    {cover ? "Remove cover" : "Make cover"}
                  </Button>
                ) : null}
                {props.disabled ? null : (
                  <Button
                    size="xs"
                    variant="ghost-destructive"
                    onClick={() => void remove(attachment)}
                  >
                    <Trash2Icon />
                    Delete
                  </Button>
                )}
              </span>
            </div>
          </li>
        );
      })}
      {preview ? <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

export function KanbanCardAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly card: KanbanCard;
  readonly disabled: boolean;
  readonly uploads: ReadonlyArray<PendingUpload>;
  readonly onAddFiles: (files: ReadonlyArray<File>) => void;
  readonly onRetry: (id: string) => void;
  readonly onDiscard: (id: string) => void;
  readonly patch: Patch;
  readonly pickerRef: RefObject<HTMLInputElement | null>;
}) {
  const { card, pickerRef } = props;
  const empty = card.attachments.length === 0 && props.uploads.length === 0;

  return (
    <section className="grid gap-3" aria-label="Attachments">
      <SectionHeading
        icon={PaperclipIcon}
        title="Attachments"
        count={card.attachments.length}
        action={
          props.disabled || empty ? null : (
            <Button size="xs" variant="ghost-muted" onClick={() => pickerRef.current?.click()}>
              Add
            </Button>
          )
        }
      />
      <input
        ref={pickerRef}
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          props.onAddFiles(files);
        }}
      />
      {empty ? (
        props.disabled ? (
          <p className="text-sm text-muted-foreground">No attachments.</p>
        ) : (
          <button
            type="button"
            onClick={() => pickerRef.current?.click()}
            className="flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-start text-sm text-muted-foreground outline-none hover:border-foreground/25 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <PaperclipIcon aria-hidden className="size-4 shrink-0" />
            <span>
              Paste, drop, or <span className="font-medium text-foreground">choose files</span> to
              attach screenshots and documents.
            </span>
          </button>
        )
      ) : (
        <ul className="grid gap-3">
          {card.attachments.length > 0 ? (
            <AttachmentRows
              environmentId={props.environmentId}
              card={card}
              disabled={props.disabled}
              patch={props.patch}
            />
          ) : null}
          {props.uploads.map((upload) => (
            <UploadRow
              key={upload.id}
              upload={upload}
              onRetry={() => props.onRetry(upload.id)}
              onDiscard={() => props.onDiscard(upload.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The card's cover image; renders nothing until the signed URL resolves. */
export function KanbanCardCover(props: {
  readonly environmentId: EnvironmentId;
  readonly card: KanbanCard;
  readonly className: string;
}) {
  const attachment = props.card.attachments.find(
    (entry) => entry.attachmentId === props.card.coverAttachmentId,
  );
  const url = useAssetUrlState(
    props.environmentId,
    attachment ? attachmentResource(attachment) : null,
  );
  if (attachment === undefined || url._tag !== "Success") return null;
  return (
    <img
      src={url.url}
      alt=""
      draggable={false}
      className={props.className}
      data-testid="kanban-card-cover"
    />
  );
}
