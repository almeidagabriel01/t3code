import type { EnvironmentId } from "@t3tools/contracts";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  ImagePlusIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  SquareCodeIcon,
  TextQuoteIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import {
  ATTACHMENT_IMAGE_EDITOR_CLASS,
  AttachmentImageEnvironment,
  hasPendingImage,
  imageFiles,
  renameAttachmentImages,
  useAttachmentImageUploads,
} from "../AttachmentImageNode";
import { readLocalApi } from "../../localApi";
import { mountedEditorView } from "../ComposerPromptEditorTiptap";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { NoteBubbleMenu, NoteTableMenu } from "./NoteBubbleMenu";
import { noteExtensions } from "./noteExtensions";
import { noteDocToMarkdown, noteMarkdownToDoc } from "./noteMarkdown";

const TOOLS: ReadonlyArray<{ label: string; icon: LucideIcon; run: (editor: Editor) => void }> = [
  {
    label: "Heading",
    icon: Heading2Icon,
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  { label: "Bold", icon: BoldIcon, run: (e) => e.chain().focus().toggleBold().run() },
  { label: "List", icon: ListIcon, run: (e) => e.chain().focus().toggleBulletList().run() },
  {
    label: "Numbered list",
    icon: ListOrderedIcon,
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: "Checklist",
    icon: ListChecksIcon,
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  { label: "Quote", icon: TextQuoteIcon, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: "Code", icon: CodeIcon, run: (e) => e.chain().focus().toggleCode().run() },
  {
    label: "Code block",
    icon: SquareCodeIcon,
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  { label: "Divider", icon: MinusIcon, run: (e) => e.chain().focus().setHorizontalRule().run() },
];

function ToolButton(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={props.label}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Edits a note's markdown in place. Blocks the editor cannot represent stay as literal source,
 * and unchanged blocks are written back byte for byte, so files edited elsewhere keep their form.
 */
export function NoteEditor(props: {
  environmentId: EnvironmentId;
  body: string;
  editable: boolean;
  autoFocus?: boolean;
  /** Image ids the server assigned to uploads; nodes still showing an upload id are renamed. */
  claimedImages?: ReadonlyMap<string, string>;
  onChange: (body: string) => void;
  /** Escape leaves the editor, for example back to the note list. */
  onExit?: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const images = useAttachmentImageUploads(props.environmentId);
  // The detail remounts this editor on reload via editorVersion; saves only serialize.
  const [linkOpen, setLinkOpen] = useState(false);
  const [initialContent] = useState(() => noteMarkdownToDoc(props.body));
  const editor = useEditor({
    extensions: noteExtensions(),
    content: initialContent,
    editable: props.editable,
    autofocus: props.autoFocus && props.editable ? "end" : false,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": "Note body",
        role: "textbox",
        "aria-multiline": "true",
        class: cn(
          "composer-tiptap min-h-64 rounded-xl border border-transparent px-1 py-4 text-base leading-7 text-foreground outline-none [overflow-wrap:anywhere] [word-break:keep-all] [&_h1]:text-2xl [&_h1]:leading-tight [&_h1]:font-semibold [&_h2]:text-lg [&_hr]:my-4 [&_ol]:list-decimal [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:whitespace-pre-wrap [&_pre[data-note-raw]]:border [&_pre[data-note-raw]]:border-dashed [&_pre[data-note-raw]]:border-border [&_ul:not([data-type=taskList])]:list-disc [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-start [&_[data-callout]]:my-3 [&_[data-callout]]:rounded-md [&_[data-callout]]:border-s-4 [&_[data-callout]]:border-info [&_[data-callout]]:bg-muted/50 [&_[data-callout]]:px-3 [&_[data-callout]]:py-2 [&_[data-callout]]:before:mb-1 [&_[data-callout]]:before:block [&_[data-callout]]:before:text-xs [&_[data-callout]]:before:font-semibold [&_[data-callout]]:before:content-[attr(data-callout)] [&_[data-callout=TIP]]:border-success [&_[data-callout=IMPORTANT]]:border-primary [&_[data-callout=WARNING]]:border-warning [&_[data-callout=CAUTION]]:border-destructive",
          ATTACHMENT_IMAGE_EDITOR_CLASS,
        ),
      },
      handleClick: (_view, _pos, event) => {
        const href = (event.target as HTMLElement).closest("a")?.getAttribute("href");
        if (!href || !(event.metaKey || event.ctrlKey)) return false;
        const api = readLocalApi();
        if (api) void api.shell.openExternal(href);
        else window.open(href, "_blank", "noopener,noreferrer");
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey &&
          event.key === "k"
        ) {
          event.preventDefault();
          setLinkOpen(true);
          return true;
        }
        if (event.key !== "Escape" || !props.onExit) return false;
        props.onExit();
        return true;
      },
      handlePaste: images.handlePaste,
      handleDrop: images.handleDrop,
    },
    onUpdate: ({ editor: current }) => {
      // An image still uploading has no id yet; its settle transaction reports the body.
      if (hasPendingImage(current.state.doc)) return;
      props.onChange(noteDocToMarkdown(current.getJSON()));
    },
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the editable prop into the imperative Tiptap editor
  useEffect(() => {
    editor?.setEditable(props.editable);
  }, [editor, props.editable]);
  const claimedImages = props.claimedImages;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- renames image nodes inside the imperative Tiptap document without a reload
  useEffect(() => {
    const view = mountedEditorView(editor);
    if (view !== null && claimedImages) renameAttachmentImages(view, claimedImages);
  }, [editor, claimedImages]);

  return (
    <AttachmentImageEnvironment value={props.environmentId}>
      <div className="flex min-w-0 flex-col" data-note-editor>
        {props.editable && (
          <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-md" data-glass-layer>
            <div
              className="mx-auto flex w-full max-w-3xl gap-0.5 overflow-x-auto px-3 py-1 md:px-7"
              role="toolbar"
              aria-label="Note formatting"
            >
              {TOOLS.map((tool) => (
                <ToolButton
                  key={tool.label}
                  label={tool.label}
                  onClick={() => editor && tool.run(editor)}
                >
                  <tool.icon aria-hidden />
                </ToolButton>
              ))}
              <ToolButton label="Insert image" onClick={() => fileInput.current?.click()}>
                <ImagePlusIcon aria-hidden />
              </ToolButton>
            </div>
          </div>
        )}
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
        <div className="mx-auto w-full max-w-3xl px-3 md:px-7">
          <EditorContent editor={editor} />
          {editor && props.editable && (
            <>
              <NoteBubbleMenu editor={editor} linkOpen={linkOpen} setLinkOpen={setLinkOpen} />
              <NoteTableMenu editor={editor} />
            </>
          )}
        </div>
      </div>
    </AttachmentImageEnvironment>
  );
}
