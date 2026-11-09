import type { MouseEvent } from "react";
import { describe, expect, it } from "vite-plus/test";

import { isSelectionClick } from "./selectionClick";

function mount() {
  const row = document.createElement("div");
  row.textContent = "tool call label";
  const outside = document.createElement("p");
  outside.textContent = "elsewhere";
  document.body.append(row, outside);
  const click = (detail: number) =>
    isSelectionClick({ detail, currentTarget: row } as unknown as MouseEvent<HTMLElement>);
  const select = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };
  return {
    row,
    outside,
    click,
    select,
    [Symbol.dispose]() {
      window.getSelection()?.removeAllRanges();
      row.remove();
      outside.remove();
    },
  };
}

describe("isSelectionClick", () => {
  it("is true only for a pointer click that ends a selection inside the row", () => {
    using page = mount();
    expect(page.click(1)).toBe(false);
    page.select(page.row);
    expect(page.click(1)).toBe(true);
    // Keyboard and synthetic clicks carry detail 0 and always act.
    expect(page.click(0)).toBe(false);
    page.select(page.outside);
    expect(page.click(1)).toBe(false);
  });
});
