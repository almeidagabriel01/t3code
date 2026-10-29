import { Extension, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  ComposerTaskListExtension,
} from "../../composer-rich-text-doc";
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
      link: false,
      underline: false,
      trailingNode: false,
    }),
    ComposerCodeExtension,
    ComposerCodeBlockExtension,
    ...ComposerListExtensions,
    ...ComposerBlockExtensions,
    ComposerTaskListExtension,
    ComposerTaskItemExtension,
    AttachmentImage,
    NoteRawMarkdown,
    NoteSource,
  ];
}
