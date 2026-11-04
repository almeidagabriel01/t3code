import { useAtomValue } from "@effect/atom-react";

import { environmentPresentations } from "../../state/presentation";
import { collectUsageItems, usageEnvironments, type UsageItem } from "./usageItems.logic";

/** One item per usage-reporting provider instance of every connected environment. */
export function useUsageItems(): {
  readonly environmentIds: ReadonlyArray<UsageItem["environmentId"]>;
  readonly items: ReadonlyArray<UsageItem>;
} {
  const all = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const shown = usageEnvironments(all);
  const connected = [...shown].flatMap(([environmentId, presentation]) =>
    presentation.connection.phase === "connected" ? [environmentId] : [],
  );
  return { environmentIds: connected, items: collectUsageItems(shown) };
}
