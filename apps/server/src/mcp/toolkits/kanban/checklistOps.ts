import type { KanbanChecklistItem } from "@t3tools/contracts";

export type ChecklistOp =
  | string
  | {
      readonly item?: string | undefined;
      readonly text?: string | undefined;
      readonly done?: boolean | undefined;
    };

type Item = Pick<KanbanChecklistItem, "text" | "done"> & { readonly id?: string };

/** Applies agent edits to a checklist; `error` names an entry that matches no item or several. */
export const applyChecklistOps = <T extends Item>(
  items: ReadonlyArray<T>,
  ops: ReadonlyArray<ChecklistOp>,
): { readonly items: ReadonlyArray<Item>; readonly error?: string } => {
  let next: Item[] = items.map(({ id, text, done }) => ({ ...(id ? { id } : {}), text, done }));
  for (const rawOp of ops) {
    // Models often tick an item by sending `{text, done}` without `item`; treat an exact text match as that edit.
    const op =
      typeof rawOp !== "string" &&
      rawOp.item === undefined &&
      rawOp.done !== undefined &&
      rawOp.text !== undefined &&
      next.some((item) => item.text.trim().toLowerCase() === rawOp.text!.trim().toLowerCase())
        ? { item: rawOp.text, done: rawOp.done }
        : rawOp;
    if (typeof op === "string" || op.item === undefined) {
      const text = typeof op === "string" ? op : op.text;
      if (text === undefined || text.trim() === "")
        return { items: next, error: "A new checklist item needs `text`." };
      next.push({ text, done: typeof op === "string" ? false : (op.done ?? false) });
      continue;
    }
    const key = op.item.trim().toLowerCase();
    const byId = next.filter((item) => item.id === op.item);
    const matches =
      byId.length > 0 ? byId : next.filter((item) => item.text.trim().toLowerCase() === key);
    if (matches.length !== 1) {
      return {
        items: next,
        error: `${matches.length === 0 ? "No" : "Several"} checklist items match "${op.item}". Use the item id.`,
      };
    }
    const target = matches[0]!;
    next = next.map((item) =>
      item === target ? { ...item, text: op.text ?? item.text, done: op.done ?? item.done } : item,
    );
  }
  return { items: next };
};
