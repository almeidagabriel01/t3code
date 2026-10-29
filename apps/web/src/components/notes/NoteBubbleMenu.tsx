import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  PilcrowIcon,
  StrikethroughIcon,
  UnlinkIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

const surface = "flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-lg/5";

function Tool(props: { label: string; icon: LucideIcon; active?: boolean; onClick: () => void }) {
  return (
    <Button
      size="icon-xs"
      variant={props.active ? "secondary" : "ghost-muted"}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      // Keep the selection in the editor while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      <props.icon aria-hidden />
    </Button>
  );
}

function LinkForm(props: { editor: Editor; onDone: () => void }) {
  const { editor, onDone } = props;
  const [href, setHref] = useState<string>(editor.getAttributes("link").href ?? "");
  const apply = () => {
    const value = href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    (value ? chain.setLink({ href: value }) : chain.unsetLink()).run();
    onDone();
  };
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <Input
        autoFocus
        size="compact"
        className="w-56"
        aria-label="Link URL"
        placeholder="Paste a link"
        value={href}
        onChange={(event) => setHref(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onDone();
          editor.commands.focus();
        }}
      />
      {editor.isActive("link") && (
        <Tool
          label="Remove link"
          icon={UnlinkIcon}
          onClick={() => {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            onDone();
          }}
        />
      )}
    </form>
  );
}

/** Formatting for the selected text; also appears on a link to edit or remove it. */
export function NoteBubbleMenu(props: {
  editor: Editor;
  linkOpen: boolean;
  setLinkOpen: (open: boolean) => void;
}) {
  const { editor, linkOpen, setLinkOpen } = props;
  const turn = (level: 1 | 2 | 3) => editor.chain().focus().toggleHeading({ level }).run();
  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: current, state, view, element }) => {
        if (
          !current.isEditable ||
          current.isActive("codeBlock") ||
          current.isActive("noteRawMarkdown")
        )
          return false;
        const focused = view.hasFocus() || element.contains(document.activeElement);
        return focused && (linkOpen || !state.selection.empty || current.isActive("link"));
      }}
    >
      <div className={surface} role="toolbar" aria-label="Text formatting">
        {linkOpen ? (
          <LinkForm editor={editor} onDone={() => setLinkOpen(false)} />
        ) : (
          <>
            <Tool
              label="Text"
              icon={PilcrowIcon}
              onClick={() => editor.chain().focus().setParagraph().run()}
            />
            <Tool
              label="Heading 1"
              icon={Heading1Icon}
              active={editor.isActive("heading", { level: 1 })}
              onClick={() => turn(1)}
            />
            <Tool
              label="Heading 2"
              icon={Heading2Icon}
              active={editor.isActive("heading", { level: 2 })}
              onClick={() => turn(2)}
            />
            <Tool
              label="Heading 3"
              icon={Heading3Icon}
              active={editor.isActive("heading", { level: 3 })}
              onClick={() => turn(3)}
            />
            <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
            <Tool
              label="Bold"
              icon={BoldIcon}
              active={editor.isActive("bold")}
              onClick={() => editor.chain().focus().toggleBold().run()}
            />
            <Tool
              label="Italic"
              icon={ItalicIcon}
              active={editor.isActive("italic")}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            />
            <Tool
              label="Strikethrough"
              icon={StrikethroughIcon}
              active={editor.isActive("strike")}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            />
            <Tool
              label="Inline code"
              icon={CodeIcon}
              active={editor.isActive("code")}
              onClick={() => editor.chain().focus().toggleCode().run()}
            />
            <Tool
              label={editor.isActive("link") ? "Edit link" : "Link"}
              icon={LinkIcon}
              active={editor.isActive("link")}
              onClick={() => setLinkOpen(true)}
            />
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

/** Row and column controls while the caret is inside a table. */
export function NoteTableMenu(props: { editor: Editor }) {
  const { editor } = props;
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="noteTableMenu"
      options={{ placement: "top-start", offset: 8 }}
      shouldShow={({ editor: current, view, element }) =>
        current.isEditable &&
        current.isActive("table") &&
        (view.hasFocus() || element.contains(document.activeElement))
      }
    >
      <div className={surface} role="toolbar" aria-label="Table">
        {(
          [
            ["+ Row", () => editor.chain().focus().addRowAfter().run()],
            ["- Row", () => editor.chain().focus().deleteRow().run()],
            ["+ Column", () => editor.chain().focus().addColumnAfter().run()],
            ["- Column", () => editor.chain().focus().deleteColumn().run()],
            ["Delete table", () => editor.chain().focus().deleteTable().run()],
          ] as const
        ).map(([label, run]) => (
          <Button
            key={label}
            size="xs"
            variant="ghost-muted"
            onMouseDown={(event) => event.preventDefault()}
            onClick={run}
          >
            {label}
          </Button>
        ))}
      </div>
    </BubbleMenu>
  );
}
