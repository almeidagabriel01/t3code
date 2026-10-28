import { useAtomValue } from "@effect/atom-react";

import { environmentPresentations } from "../../state/presentation";
import { collectUsageItems, type UsageItem } from "./usageItems.logic";

/** One item per usage-reporting provider instance of every connected environment. */
export function useUsageItems(): {
  readonly environmentIds: ReadonlyArray<UsageItem["environmentId"]>;
  readonly items: ReadonlyArray<UsageItem>;
} {
  const all = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const connected = new Map(
    [...all].filter(([, presentation]) => presentation.connection.phase === "connected"),
  );
  return { environmentIds: [...connected.keys()], items: collectUsageItems(connected) };
}
