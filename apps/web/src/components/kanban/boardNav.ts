export type CardNavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export function isCardNavKey(key: string): key is CardNavKey {
  return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
}

/** The card to focus after `key` from `currentId`, or null when there is nowhere to go. */
export function nextCardFocus(
  columns: ReadonlyArray<{ readonly cardIds: ReadonlyArray<string> }>,
  currentId: string,
  key: CardNavKey,
): string | null {
  const col = columns.findIndex((entry) => entry.cardIds.includes(currentId));
  if (col < 0) return null;
  const index = columns[col]!.cardIds.indexOf(currentId);
  if (key === "ArrowUp" || key === "ArrowDown") {
    return columns[col]!.cardIds[index + (key === "ArrowUp" ? -1 : 1)] ?? null;
  }
  const step = key === "ArrowLeft" ? -1 : 1;
  for (let next = col + step; next >= 0 && next < columns.length; next += step) {
    const ids = columns[next]!.cardIds;
    if (ids.length > 0) return ids[Math.min(index, ids.length - 1)]!;
  }
  return null;
}
