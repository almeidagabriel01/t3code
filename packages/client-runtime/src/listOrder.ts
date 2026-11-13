/** Sorts `items` into `order` by key. Items missing from `order` follow, in their own order. */
export function keepOrder<T>(
  items: ReadonlyArray<T>,
  order: ReadonlyArray<string> | null,
  key: (item: T) => string,
): T[] {
  if (order === null) return [...items];
  const rank = new Map(order.map((itemKey, index) => [itemKey, index]));
  return items
    .map((item, index) => ({ item, rank: rank.get(key(item)) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

/** `order` with keys it has not seen added at the end, or `order` itself when nothing is new. */
export function withArrivedKeys(
  order: ReadonlyArray<string> | null,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  const known = new Set(order);
  const arrived = keys.filter((itemKey) => !known.has(itemKey));
  return arrived.length === 0 ? order : [...(order ?? []), ...arrived];
}
