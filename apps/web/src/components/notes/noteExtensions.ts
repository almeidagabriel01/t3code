import { Extension, Node } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import {
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  ComposerTaskListExtension,
} from "../../composer-rich-text-doc";
import { NoteSlashCommand } from "./noteSlashCommand";
import { AttachmentImage } from "../AttachmentImageNode";

const NoteSource = Extension.create({
  name: "noteSource",
  addGlobalAttributes() {
    return [
      {
        types: [
          "paragraph",
          "heading",
          "bulletList",
          "orderedList",
          "taskList",
          "blockquote",
          "callout",
          "table",
          "codeBlock",
          "horizontalRule",
          "attachmentImage",
        ],
        attributes: {
          // A split keeps these on the first half only, so leading text is never written twice.
          notePrefix: { default: "", rendered: false, keepOnSplit: false },
          noteSource: { default: null, rendered: false },
          noteFingerprint: { default: null, rendered: false },
          noteSuffix: { default: "\n\n", rendered: false },
          noteTail: { default: false, rendered: false, keepOnSplit: false },
        },
      },
    ];
  },
});

const NoteRawMarkdown = Node.create({
  name: "noteRawMarkdown",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes: () => ({
    notePrefix: { default: "", rendered: false, keepOnSplit: false },
    noteSuffix: { default: "\n\n", rendered: false },
    noteTail: { default: false, rendered: false, keepOnSplit: false },
  }),
  parseHTML: () => [{ tag: "pre[data-note-raw]", preserveWhitespace: "full" }],
  renderHTML: () => ["pre", { "data-note-raw": "", "aria-label": "Raw markdown" }, ["code", {}, 0]],
});

// A GitHub alert: `> [!NOTE]` followed by paragraphs.
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "paragraph+",
  defining: true,
  addAttributes: () => ({
    kind: {
      default: "NOTE",
      rendered: false,
    },
  }),
  parseHTML: () => [
    { tag: "div[data-callout]", getAttrs: (el) => ({ kind: el.getAttribute("data-callout") }) },
  ],
  renderHTML: ({ node }) => ["div", { "data-callout": node.attrs.kind }, 0],
  addKeyboardShortcuts() {
    // Enter on the empty last paragraph leaves the callout, like a list item.
    return {
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        const parent = $from.node(-1);
        if (!empty || parent.type.name !== "callout" || $from.parent.content.size > 0) return false;
        if ($from.index(-1) !== parent.childCount - 1 || parent.childCount < 2) return false;
        return editor.commands.liftEmptyBlock();
      },
    };
  },
});

// A markdown cell is one line of inline content.
const NoteTableCell = TableCell.extend({ content: "paragraph" });
const NoteTableHeader = TableHeader.extend({ content: "paragraph" });

export function noteExtensions() {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      code: false,
      underline: false,
      trailingNode: false,
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer" } },
    }),
    ComposerCodeExtension,
    ComposerCodeBlockExtension,
    ...ComposerListExtensions,
    ...ComposerBlockExtensions,
    ComposerTaskListExtension,
    ComposerTaskItemExtension,
    Table,
    TableRow,
    NoteTableHeader,
    NoteTableCell,
    Callout,
    AttachmentImage,
    NoteSlashCommand,
    NoteRawMarkdown,
    NoteSource,
  ];
}
