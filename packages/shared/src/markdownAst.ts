import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type { ListItem, PhrasingContent, Root, RootContent, Table, TableRow } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm);

/** CommonMark plus GFM (tables, task lists, strikethrough, autolink literals), as chat shows it. */
export const parseMarkdown = (markdown: string): Root => parser.parse(markdown);
