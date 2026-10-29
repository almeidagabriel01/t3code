import { Extension, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import {
  AlertCircleIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  LightbulbIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  PilcrowIcon,
  SquareCodeIcon,
  TableIcon,
  TextQuoteIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useImperativeHandle, useState, type Ref } from "react";

import { cn } from "../../lib/utils";

interface SlashItem {
  readonly title: string;
  readonly keywords: string;
  readonly icon: LucideIcon;
  readonly run: (editor: Editor) => void;
}

const callout = (kind: string) => (editor: Editor) =>
  editor
    .chain()
    .insertContent({ type: "callout", attrs: { kind }, content: [{ type: "paragraph" }] })
    .run();

function insertTable(editor: Editor) {
  editor
    .chain()
    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    .command(({ tr, state }) => {
      // A table that ends the note leaves nowhere to type after it.
      if (state.doc.lastChild?.type.name === "table")
        tr.insert(tr.doc.content.size, state.schema.nodes.paragraph!.create());
      return true;
    })
    .run();
}

const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Text",
    keywords: "paragraph plain",
    icon: PilcrowIcon,
    run: (e) => e.chain().setParagraph().run(),
  },
  {
    title: "Heading 1",
    keywords: "h1 title",
    icon: Heading1Icon,
    run: (e) => e.chain().setHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",
    keywords: "h2 subtitle",
    icon: Heading2Icon,
    run: (e) => e.chain().setHeading({ level: 2 }).run(),
  },
  {
    title: "Heading 3",
    keywords: "h3",
    icon: Heading3Icon,
    run: (e) => e.chain().setHeading({ level: 3 }).run(),
  },
  {
    title: "Bulleted list",
    keywords: "ul unordered",
    icon: ListIcon,
    run: (e) => e.chain().toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    keywords: "ol ordered",
    icon: ListOrderedIcon,
    run: (e) => e.chain().toggleOrderedList().run(),
  },
  {
    title: "To-do list",
    keywords: "task checkbox checklist",
    icon: ListChecksIcon,
    run: (e) => e.chain().toggleTaskList().run(),
  },
  {
    title: "Quote",
    keywords: "blockquote",
    icon: TextQuoteIcon,
    run: (e) => e.chain().toggleBlockquote().run(),
  },
  { title: "Callout", keywords: "note info alert", icon: AlertCircleIcon, run: callout("NOTE") },
  { title: "Tip callout", keywords: "callout hint", icon: LightbulbIcon, run: callout("TIP") },
  {
    title: "Warning callout",
    keywords: "callout caution",
    icon: TriangleAlertIcon,
    run: callout("WARNING"),
  },
  {
    title: "Code block",
    keywords: "fence pre",
    icon: SquareCodeIcon,
    run: (e) => e.chain().toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    keywords: "hr rule line",
    icon: MinusIcon,
    run: (e) => e.chain().setHorizontalRule().run(),
  },
  { title: "Table", keywords: "grid", icon: TableIcon, run: insertTable },
  {
    title: "Image",
    keywords: "picture photo upload",
    icon: ImageIcon,
    run: (e) =>
      e.view.dom
        .closest("[data-note-editor]")
        ?.querySelector<HTMLInputElement>("input[type=file]")
        ?.click(),
  },
];

function filterSlashItems(query: string, items: SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => `${item.title} ${item.keywords}`.toLowerCase().includes(needle));
}

interface SlashMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

function SlashMenu(props: SuggestionProps<SlashItem> & { ref?: Ref<SlashMenuHandle> }) {
  const { items, command, ref } = props;
  const [index, setIndex] = useState(0);
  // Typing narrows the list; keep the highlight inside it.
  const active = Math.min(index, Math.max(items.length - 1, 0));
  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (items.length === 0) return false;
      if (event.key === "ArrowDown") setIndex((active + 1) % items.length);
      else if (event.key === "ArrowUp") setIndex((active - 1 + items.length) % items.length);
      else if (event.key === "Enter") command(items[active]!);
      else return false;
      return true;
    },
  }));
  const rect = props.clientRect?.();
  if (!rect) return null;
  const below = window.innerHeight - rect.bottom > 300;
  return (
    <div
      role="listbox"
      aria-label="Insert block"
      className="fixed z-50 max-h-72 w-60 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg/5"
      style={{
        left: Math.min(rect.left, window.innerWidth - 248),
        ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
      }}
    >
      {items.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No results</div>
      ) : (
        items.map((item, i) => (
          <button
            key={item.title}
            type="button"
            role="option"
            aria-selected={i === active}
            // Keep the editor focused so the selection survives the click.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setIndex(i)}
            onClick={() => command(item)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none",
              i === active && "bg-accent text-accent-foreground",
            )}
          >
            <item.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {item.title}
          </button>
        ))
      )}
    </div>
  );
}

/** `/` at the start of a block or after a space opens the block menu. */
export const NoteSlashCommand = Extension.create({
  name: "noteSlashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: "/",
        allow: ({ state, range }) => {
          const parent = state.doc.resolve(range.from).parent;
          return parent.type.name === "paragraph" || parent.type.name === "heading";
        },
        items: ({ query }) => filterSlashItems(query),
        command: ({
          editor,
          range,
          props: item,
        }: {
          editor: Editor;
          range: Range;
          props: SlashItem;
        }) => {
          editor.chain().focus().deleteRange(range).run();
          item.run(editor);
        },
        render: () => {
          let renderer: ReactRenderer<SlashMenuHandle, SuggestionProps<SlashItem>> | null = null;
          return {
            onStart: (props) => {
              renderer = new ReactRenderer(SlashMenu, { props, editor: props.editor });
              document.body.append(renderer.element);
            },
            onUpdate: (props) => renderer?.updateProps(props),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
              if (event.key === "Escape") {
                renderer?.destroy();
                renderer?.element.remove();
                renderer = null;
                return true;
              }
              return renderer?.ref?.onKeyDown(event) ?? false;
            },
            onExit: () => {
              renderer?.destroy();
              renderer?.element.remove();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});
