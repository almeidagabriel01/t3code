import type { EnvironmentId } from "@t3tools/contracts";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ImagePlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { buildDocJson, serializeEditorDoc } from "../../composer-rich-text-doc";
import {
  ATTACHMENT_IMAGE_EDITOR_CLASS,
  AttachmentImage,
  AttachmentImageEnvironment,
  hasPendingImage,
  imageFiles,
  useAttachmentImageUploads,
} from "../AttachmentImageNode";
import { mountedEditorView, RICH_MARKDOWN_EXTENSIONS } from "../ComposerPromptEditorTiptap";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

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

/** Markdown description editing that shows `t3-attachment:` image refs as the images themselves. */
export function KanbanDescriptionEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly initial: string;
  readonly onSave: (text: string) => void;
  readonly onClose: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [content] = useState(() =>
    buildDocJson(props.initial, () => null, { atoms: false, images: true }),
  );

  const images = useAttachmentImageUploads(props.environmentId);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content,
    autofocus: "end",
    editorProps: {
      attributes: {
        class: `composer-tiptap min-h-40 rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground ${ATTACHMENT_IMAGE_EDITOR_CLASS}`,
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
      handlePaste: images.handlePaste,
      handleDrop: images.handleDrop,
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
    <AttachmentImageEnvironment value={props.environmentId}>
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
            const files = imageFiles(event.currentTarget.files);
            event.currentTarget.value = "";
            const view = mountedEditorView(editor);
            if (view !== null && files.length > 0) images.insertImages(view, files);
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
    </AttachmentImageEnvironment>
  );
}
