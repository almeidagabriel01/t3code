type PanelTabKeyAction =
  | { readonly type: "focus"; readonly index: number }
  | { readonly type: "activate" }
  | { readonly type: "close" };

/**
 * Keyboard behavior for the panel tab list. Arrows move focus without opening the tab, since a
 * browser or terminal surface is costly to start; Enter or Space opens it and Delete closes it.
 */
export function panelTabKeyAction(
  key: string,
  index: number,
  count: number,
): PanelTabKeyAction | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return { type: "focus", index: (index + 1) % count };
    case "ArrowLeft":
      return { type: "focus", index: (index - 1 + count) % count };
    case "Home":
      return { type: "focus", index: 0 };
    case "End":
      return { type: "focus", index: count - 1 };
    case "Enter":
    case " ":
      return { type: "activate" };
    case "Delete":
    case "Backspace":
      return { type: "close" };
    default:
      return null;
  }
}
