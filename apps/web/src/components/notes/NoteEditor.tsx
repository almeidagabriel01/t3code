import type { EnvironmentId } from "@t3tools/contracts";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
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
import { Fragment, useEffect, useRef, useState } from "react";

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
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { NoteBubbleMenu, NoteTableMenu } from "./NoteBubbleMenu";
import { noteExtensions } from "./noteExtensions";
import { noteDocToMarkdown, noteMarkdownToDoc } from "./noteMarkdown";

interface Tool {
  label: string;
  icon: LucideIcon;
  run: (editor: Editor) => void;
  /** Present for formats that can be on at the caret; Divider is an action. */
  active?: (editor: Editor) => boolean;
}

// Grouped as headings | inline marks | lists | blocks, with a divider between groups.
const TOOL_GROUPS: ReadonlyArray<ReadonlyArray<Tool>> = [
  [
    {
      label: "Heading",
      icon: Heading2Icon,
      run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
      active: (e) => e.isActive("heading", { level: 2 }),
    },
  ],
  [
    {
      label: "Bold",
      icon: BoldIcon,
      run: (e) => e.chain().focus().toggleBold().run(),
      active: (e) => e.isActive("bold"),
    },
    {
      label: "Code",
      icon: CodeIcon,
      run: (e) => e.chain().focus().toggleCode().run(),
      active: (e) => e.isActive("code"),
    },
  ],
  [
    {
      label: "List",
      icon: ListIcon,
      run: (e) => e.chain().focus().toggleBulletList().run(),
      active: (e) => e.isActive("bulletList"),
    },
    {
      label: "Numbered list",
      icon: ListOrderedIcon,
      run: (e) => e.chain().focus().toggleOrderedList().run(),
      active: (e) => e.isActive("orderedList"),
    },
    {
      label: "Checklist",
      icon: ListChecksIcon,
      run: (e) => e.chain().focus().toggleTaskList().run(),
      active: (e) => e.isActive("taskList"),
    },
  ],
  [
    {
      label: "Quote",
      icon: TextQuoteIcon,
      run: (e) => e.chain().focus().toggleBlockquote().run(),
      active: (e) => e.isActive("blockquote"),
    },
    {
      label: "Code block",
      icon: SquareCodeIcon,
      run: (e) => e.chain().focus().toggleCodeBlock().run(),
      active: (e) => e.isActive("codeBlock"),
    },
    { label: "Divider", icon: MinusIcon, run: (e) => e.chain().focus().setHorizontalRule().run() },
  ],
];

function ToolButton(props: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            variant="ghost"
            size="sm"
            pressed={props.pressed}
            aria-label={props.label}
            // Keep the caret and selection in the editor while a button is pressed.
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
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
  /** Metadata chips shown above the body, in read and edit mode alike. */
  leading?: React.ReactNode;
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
          "composer-tiptap min-h-64 rounded-xl border border-transparent px-1 pt-4 pb-24 text-base leading-7 text-foreground outline-none [overflow-wrap:anywhere] [word-break:keep-all] [&_h1]:text-2xl [&_h1]:leading-tight [&_h1]:font-semibold [&_h2]:text-lg [&_hr]:my-4 [&_ol]:list-decimal [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:whitespace-pre-wrap [&_pre[data-note-raw]]:border [&_pre[data-note-raw]]:border-dashed [&_pre[data-note-raw]]:border-border [&_ul:not([data-type=taskList])]:list-disc [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-start [&_[data-callout]]:my-3 [&_[data-callout]]:rounded-md [&_[data-callout]]:border-s-4 [&_[data-callout]]:border-info [&_[data-callout]]:bg-muted/50 [&_[data-callout]]:px-3 [&_[data-callout]]:py-2 [&_[data-callout]]:before:mb-1 [&_[data-callout]]:before:block [&_[data-callout]]:before:text-xs [&_[data-callout]]:before:font-semibold [&_[data-callout]]:before:content-[attr(data-callout)] [&_[data-callout=TIP]]:border-success [&_[data-callout=IMPORTANT]]:border-primary [&_[data-callout=WARNING]]:border-warning [&_[data-callout=CAUTION]]:border-destructive",
          ATTACHMENT_IMAGE_EDITOR_CLASS,
        ),
      },
      handleDOMEvents: {
        // ProseMirror skips the native checkbox mousedown, so handle the click; Tiptap leaves
        // read-only toggles to us, and ticking while reading saves like an edit.
        click: (view, event) => {
          const target = event.target as HTMLElement;
          if (view.editable || !(target instanceof HTMLInputElement) || target.type !== "checkbox")
            return false;
          const li = target.closest("li");
          if (!li) return false;
          const $pos = view.state.doc.resolve(view.posAtDOM(li, 0));
          let pos = $pos.nodeAfter?.type.name === "taskItem" ? $pos.pos : null;
          for (let depth = $pos.depth; pos === null && depth > 0; depth--) {
            if ($pos.node(depth).type.name === "taskItem") pos = $pos.before(depth);
          }
          const item = pos === null ? null : view.state.doc.nodeAt(pos);
          if (pos === null || !item) return false;
          // Cancelling the native toggle keeps Tiptap's change handler from undoing ours.
          event.preventDefault();
          view.dispatch(
            view.state.tr.setNodeMarkup(pos, undefined, {
              ...item.attrs,
              checked: !item.attrs.checked,
            }),
          );
          return true;
        },
      },
      handleClick: (view, _pos, event) => {
        const target = event.target as HTMLElement;
        const href = target.closest("a")?.getAttribute("href");
        // Editing keeps plain clicks for the caret; reading follows links directly.
        if (!href || (view.editable && !(event.metaKey || event.ctrlKey))) return false;
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
  const wasEditable = useRef(props.editable);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the editable prop into the imperative Tiptap editor
  useEffect(() => {
    editor?.setEditable(props.editable);
    if (props.editable && !wasEditable.current && editor) {
      // An empty transaction lets editable-only plugins (the paragraph after a final image) run first,
      // so the caret lands in text rather than selecting the image.
      editor.view.dispatch(editor.state.tr);
      editor.commands.focus("end");
    }
    wasEditable.current = props.editable;
  }, [editor, props.editable]);
  const toolbar = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current === null
        ? null
        : Object.fromEntries(
            TOOL_GROUPS.flat().map((tool) => [tool.label, tool.active?.(current) ?? false]),
          ),
    equalityFn: (a, b) =>
      a === b || (a !== null && b !== null && Object.keys(a).every((key) => a[key] === b[key])),
  });
  const claimedImages = props.claimedImages;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- renames image nodes inside the imperative Tiptap document without a reload
  useEffect(() => {
    const view = mountedEditorView(editor);
    if (view !== null && claimedImages) renameAttachmentImages(view, claimedImages);
  }, [editor, claimedImages]);

  return (
    <AttachmentImageEnvironment value={props.environmentId}>
      <div className="flex min-w-0 flex-1 flex-col" data-note-editor>
        {props.leading && (
          <div className="border-b border-border" data-glass-layer>
            <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-1.5 px-3 py-2 @2xl/note:px-8">
              {props.leading}
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
        <div className="mx-auto w-full max-w-3xl flex-1 px-3 @2xl/note:px-8">
          <EditorContent editor={editor} />
          {editor && props.editable && (
            <>
              <NoteBubbleMenu editor={editor} linkOpen={linkOpen} setLinkOpen={setLinkOpen} />
              <NoteTableMenu editor={editor} />
            </>
          )}
        </div>
        {props.editable && (
          // Zero height, so the pill overlays the body and toggling edit mode moves nothing.
          <div className="pointer-events-none sticky bottom-0 z-10 h-0">
            <div className="absolute inset-x-0 bottom-3 flex justify-center px-3">
              <div
                className="dialog-glass pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border p-1 text-foreground [&_[data-pressed]]:bg-foreground/14 [&_[data-slot=toggle]:hover]:bg-foreground/10"
                role="toolbar"
                aria-label="Note formatting"
              >
                {TOOL_GROUPS.map((group, index) => (
                  <Fragment key={group[0]!.label}>
                    {index > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-foreground/15" />}
                    {group.map((tool) => (
                      <ToolButton
                        key={tool.label}
                        label={tool.label}
                        pressed={toolbar?.[tool.label] ?? false}
                        onClick={() => editor && tool.run(editor)}
                      >
                        <tool.icon aria-hidden />
                      </ToolButton>
                    ))}
                  </Fragment>
                ))}
                <span aria-hidden className="mx-1 h-4 w-px bg-foreground/15" />
                <ToolButton
                  label="Insert image"
                  pressed={false}
                  onClick={() => fileInput.current?.click()}
                >
                  <ImagePlusIcon aria-hidden />
                </ToolButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </AttachmentImageEnvironment>
  );
}
