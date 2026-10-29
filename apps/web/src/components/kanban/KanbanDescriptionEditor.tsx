import type { EnvironmentId } from "@t3tools/contracts";
import { Node } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
  type ReactNodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ImageIcon, ImagePlusIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { buildDocJson, serializeEditorDoc } from "../../composer-rich-text-doc";
import { uploadStandaloneAttachment } from "../../lib/attachmentUploadQueue";
import { cn, randomUUID } from "../../lib/utils";
import { mountedEditorView, RICH_MARKDOWN_EXTENSIONS } from "../ComposerPromptEditorTiptap";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

interface ImageAttrs {
  readonly attachmentId: string;
  readonly name: string;
  /** Object URL shown while the upload runs and until the editor closes. */
  readonly previewUrl: string | null;
  readonly pendingId: string | null;
}

const DescriptionEnvironment = createContext<EnvironmentId | null>(null);

function AttachmentImageView(props: ReactNodeViewProps) {
  const environmentId = useContext(DescriptionEnvironment);
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

const AttachmentImage = Node.create({
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

const EXTENSIONS = [
  StarterKit.configure({
    blockquote: false,
    bulletList: false,
    codeBlock: false,
    heading: false,
    horizontalRule: false,
    listItem: false,
    link: false,
    orderedList: false,
    underline: false,
    trailingNode: false,
    code: false,
    listKeymap: false,
    italic: false,
  }),
  ...RICH_MARKDOWN_EXTENSIONS,
  AttachmentImage,
];

const imageFiles = (files: FileList | null | undefined) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));

const hasPendingImage = (doc: ProseMirrorNode) => {
  let pending = false;
  doc.descendants((node) => {
    if (node.attrs.pendingId) pending = true;
    return !pending;
  });
  return pending;
};

/** Markdown description editing that shows `t3-attachment:` image refs as the images themselves. */
export function KanbanDescriptionEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly initial: string;
  readonly onSave: (text: string) => void;
  readonly onClose: () => void;
}) {
  const previewUrls = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  const [content] = useState(() =>
    buildDocJson(props.initial, () => null, { atoms: false, images: true }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- object URLs are browser resources the editor must release when it closes
  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const settle = (view: EditorView, pendingId: string, attachmentId: string | null) => {
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
  };

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
      uploadStandaloneAttachment(props.environmentId, item.file).then(
        ({ attachmentId }) => settle(view, item.pendingId, attachmentId),
        (cause: unknown) => {
          settle(view, item.pendingId, null);
          toastManager.add({
            type: "error",
            title: "Could not attach image",
            description: cause instanceof Error ? cause.message : "Upload failed",
          });
        },
      );
    }
  };

  const editor = useEditor({
    extensions: EXTENSIONS,
    content,
    autofocus: "end",
    editorProps: {
      attributes: {
        class:
          "composer-tiptap min-h-40 rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground ring-ring/24 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-inset [&_.ProseMirror-selectednode]:outline-none!",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Description",
      },
      handleKeyDown: (view, event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onClose();
          return true;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          save(view);
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const images = imageFiles(event.clipboardData?.files);
        if (images.length === 0) return false;
        insertImages(view, images);
        return true;
      },
      handleDrop: (view, event) => {
        const images = imageFiles(event.dataTransfer?.files);
        if (images.length === 0) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertImages(view, images, at);
        return true;
      },
    },
  });

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current === null
        ? { pending: false, empty: true }
        : { pending: hasPendingImage(current.state.doc), empty: current.isEmpty },
  });
  const pending = state?.pending ?? false;

  function save(view: EditorView) {
    if (hasPendingImage(view.state.doc)) return;
    const text = serializeEditorDoc(view.state.doc).value;
    if (text !== props.initial) props.onSave(text);
    props.onClose();
  }

  return (
    <DescriptionEnvironment value={props.environmentId}>
      <div className="grid gap-2">
        <div className="relative">
          <EditorContent editor={editor} />
          {state?.empty ? (
            <span className="pointer-events-none absolute start-3 top-2 text-sm text-muted-foreground">
              Add more detail. Markdown works, and pasted screenshots land inline.
            </span>
          ) : null}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const images = imageFiles(event.currentTarget.files);
            event.currentTarget.value = "";
            const view = mountedEditorView(editor);
            if (view !== null && images.length > 0) insertImages(view, images);
          }}
        />
        <div className="flex items-center justify-end gap-2">
          <span className="me-auto">
            <Button size="xs" variant="ghost-muted" onClick={() => fileInput.current?.click()}>
              {pending ? <Spinner /> : <ImagePlusIcon />}
              Insert image
            </Button>
          </span>
          <Button size="xs" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={pending}
            onClick={() => {
              const view = mountedEditorView(editor);
              if (view !== null) save(view);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </DescriptionEnvironment>
  );
}
