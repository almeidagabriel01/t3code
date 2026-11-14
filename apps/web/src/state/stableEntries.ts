/**
 * Keeps the previous entry objects (and the previous list) where nothing a row reads changed, so a
 * list derived again on every event does not re-render each memoized row.
 */
export function reuseEntries<T>(
  previous: ReadonlyArray<T> | undefined,
  next: ReadonlyArray<T>,
  keyOf: (entry: T) => string,
  same: (previous: T, next: T) => boolean,
): ReadonlyArray<T> {
  if (previous === undefined) return next;
  const byKey = new Map(previous.map((entry) => [keyOf(entry), entry]));
  let changed = previous.length !== next.length;
  const merged = next.map((entry, index) => {
    const prior = byKey.get(keyOf(entry));
    const kept = prior !== undefined && same(prior, entry) ? prior : entry;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? merged : previous;
}

/**
 * The server replaces a record whenever it changes and stamps `updatedAt`; a reconnect snapshot
 * rebuilds every record with the same stamps, so those still count as unchanged.
 */
export const sameStamped = (
  previous: { readonly id: string; readonly updatedAt: string },
  next: { readonly id: string; readonly updatedAt: string },
): boolean =>
  previous === next || (previous.id === next.id && previous.updatedAt === next.updatedAt);
