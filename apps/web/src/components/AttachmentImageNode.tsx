import type { EnvironmentId } from "@t3tools/contracts";
import { Node } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { ImageIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef } from "react";

import { useAssetUrlState } from "../assets/assetUrls";
import { uploadStandaloneAttachment } from "../lib/attachmentUploadQueue";
import { cn, randomUUID } from "../lib/utils";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

interface ImageAttrs {
  readonly attachmentId: string;
  readonly name: string;
  /** Object URL shown while the upload runs and until the editor closes. */
  readonly previewUrl: string | null;
  readonly pendingId: string | null;
}

/** The environment that serves the images of the editor below it. */
export const AttachmentImageEnvironment = createContext<EnvironmentId | null>(null);

function AttachmentImageView(props: ReactNodeViewProps) {
  const environmentId = useContext(AttachmentImageEnvironment);
  const { attachmentId, name, previewUrl, pendingId } = props.node.attrs as ImageAttrs;
  const asset = useAssetUrlState(
    environmentId,
    previewUrl === null && attachmentId ? { _tag: "attachment", attachmentId } : null,
  );
  const src = previewUrl ?? (asset._tag === "Success" ? asset.url : null);
  return (
    <NodeViewWrapper className="py-1">
      <span
        className={cn(
          "relative inline-flex max-w-full overflow-hidden rounded-lg border border-border bg-muted",
          props.selected && "ring-2 ring-ring",
        )}
      >
        {src === null ? (
          <span role="img" aria-label={name} className="flex h-20 w-28 items-center justify-center">
            <ImageIcon aria-hidden className="size-5 text-muted-foreground" />
          </span>
        ) : (
          <img src={src} alt={name} draggable={false} className="max-h-80 max-w-full" />
        )}
        {pendingId === null ? null : (
          <Spinner aria-label={`Uploading ${name}`} className="absolute end-2 top-2" />
        )}
      </span>
    </NodeViewWrapper>
  );
}

/** A `![name](t3-attachment:id)` image as a block; a pending upload has an empty id. */
export const AttachmentImage = Node.create({
  name: "attachmentImage",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({
    attachmentId: { default: "", rendered: false },
    name: { default: "", rendered: false },
    previewUrl: { default: null, rendered: false },
    pendingId: { default: null, rendered: false },
  }),
  parseHTML: () => [
    {
      tag: "img[data-attachment-id]",
      getAttrs: (element) => ({
        attachmentId: element.getAttribute("data-attachment-id") ?? "",
        name: element.getAttribute("alt") ?? "",
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "img",
    { "data-attachment-id": node.attrs.attachmentId, alt: node.attrs.name },
  ],
  addNodeView: () => ReactNodeViewRenderer(AttachmentImageView),
});

/**
 * Editor classes that leave the image node's own ring as the only selection mark: the editor
 * keeps its inset focus ring and ProseMirror's selected-node outline is removed.
 */
export const ATTACHMENT_IMAGE_EDITOR_CLASS =
  "ring-ring/24 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-inset [&_.ProseMirror-selectednode]:outline-none!";

export const imageFiles = (files: FileList | null | undefined) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));

export const hasPendingImage = (doc: ProseMirrorNode) => {
  let pending = false;
  doc.descendants((node) => {
    if (node.attrs.pendingId) pending = true;
    return !pending;
  });
  return pending;
};

function settleImage(view: EditorView, pendingId: string, attachmentId: string | null) {
  if (view.isDestroyed) return;
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (node.attrs.pendingId === pendingId) found = { node, pos };
    return found === null;
  });
  if (found === null) return;
  const { node, pos } = found as { node: ProseMirrorNode; pos: number };
  const tr =
    attachmentId === null
      ? view.state.tr.delete(pos, pos + node.nodeSize)
      : view.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          attachmentId,
          pendingId: null,
        });
  view.dispatch(tr.setMeta("addToHistory", false));
}

/** Rewrites image ids in place, without an undo step, after the server claims uploads. */
export function renameAttachmentImages(view: EditorView, ids: ReadonlyMap<string, string>) {
  if (view.isDestroyed || ids.size === 0) return;
  const tr = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    const next = node.type.name === "attachmentImage" ? ids.get(node.attrs.attachmentId) : null;
    if (next) tr.setNodeMarkup(pos, undefined, { ...node.attrs, attachmentId: next });
  });
  if (tr.docChanged) view.dispatch(tr.setMeta("addToHistory", false));
}

/**
 * Pasted, dropped, and picked images upload to the environment and show a local preview until
 * the editor unmounts. Spread `handlePaste` and `handleDrop` into the editor's props.
 */
export function useAttachmentImageUploads(environmentId: EnvironmentId) {
  const previewUrls = useRef(new Set<string>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- object URLs are browser resources the editor must release when it closes
  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const insertImages = (view: EditorView, files: ReadonlyArray<File>, at?: number) => {
    const type = view.state.schema.nodes.attachmentImage!;
    const items = files.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.add(previewUrl);
      return { file, previewUrl, pendingId: randomUUID() };
    });
    const slice = new Slice(
      Fragment.from(
        items.map((item) =>
          type.create({
            name: item.file.name || "image",
            previewUrl: item.previewUrl,
            pendingId: item.pendingId,
          }),
        ),
      ),
      0,
      0,
    );
    view.dispatch(
      at === undefined
        ? view.state.tr.replaceSelection(slice)
        : view.state.tr.replace(at, at, slice),
    );
    for (const item of items) {
      uploadStandaloneAttachment(environmentId, item.file).then(
        ({ attachmentId }) => settleImage(view, item.pendingId, attachmentId),
        (cause: unknown) => {
          settleImage(view, item.pendingId, null);
          toastManager.add({
            type: "error",
            title: "Could not attach image",
            description: cause instanceof Error ? cause.message : "Upload failed",
          });
        },
      );
    }
  };

  return {
    insertImages,
    handlePaste: (view: EditorView, event: ClipboardEvent) => {
      const images = imageFiles(event.clipboardData?.files);
      if (images.length === 0) return false;
      insertImages(view, images);
      return true;
    },
    handleDrop: (view: EditorView, event: DragEvent) => {
      const images = imageFiles(event.dataTransfer?.files);
      if (images.length === 0) return false;
      const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
      insertImages(view, images, at);
      return true;
    },
  };
}
