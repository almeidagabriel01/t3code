import { useState } from "react";

import { keepOrder, withArrivedKeys } from "@t3tools/client-runtime/list-order";

/**
 * Keeps the order a list had when it opened, so a row that a pin moves does not slide out
 * from under the pointer or the keyboard highlight. Rows that load later join at the end and
 * then hold their place too. The new order shows on the next open.
 */
export function useOrderWhileOpen<T>(
  items: ReadonlyArray<T>,
  key: (item: T) => string,
  open: boolean,
): T[] {
  const [order, setOrder] = useState<ReadonlyArray<string> | null>(null);
  if (!open) {
    if (order !== null) setOrder(null);
    return [...items];
  }
  const ordered = keepOrder(items, order, key);
  const nextOrder = withArrivedKeys(order, ordered.map(key));
  if (nextOrder !== order) setOrder(nextOrder);
  return ordered;
}
