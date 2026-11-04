import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { Fragment, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { buildHomeActivityEntries } from "./homeActivityEntries";
import {
  buildThreadListV2ListItems,
  type ThreadListV2ThreadListItem,
} from "../threads/threadListV2";

/**
 * Threads waiting on the user, in the order of web's Activity page. Working and finished agents
 * are listed by the Agents section above, so they are left out here instead of listed twice.
 */
export function HomeNeedsYouSection(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly gutter: number;
  readonly sidebar?: boolean;
  /** Renders a thread as the app's list row, with the handlers of the list that hosts this section. */
  readonly renderRow: (item: ThreadListV2ThreadListItem) => ReactNode;
}) {
  const openDecisionThreadKeys = useOpenDecisionThreadKeys();
  const entries = buildHomeActivityEntries({
    threads: props.threads,
    now: props.now,
    openDecisionThreadKeys,
  }).filter((entry) => entry.rank === 0);
  if (entries.length === 0) return null;
  const muted = props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary";
  const items = buildThreadListV2ListItems({
    items: entries.map(({ thread }) => ({
      thread,
      variant: "card" as const,
      snoozed: false,
      pinned: thread.pinnedAt != null,
      wokeAt: threadWokeAt(thread, { now: props.now }),
      isLast: false,
    })),
    pendingTasks: [],
  }).filter((item) => item.type === "v2-thread");

  return (
    <View className="pb-3 pt-2">
      <View className="min-h-9 flex-row items-center" style={{ paddingHorizontal: props.gutter }}>
        <Text className={cn("flex-1 font-t3-bold text-2xs uppercase tracking-[1.1px]", muted)}>
          Needs you
        </Text>
      </View>
      {items.map((item) => (
        <Fragment key={item.key}>{props.renderRow(item)}</Fragment>
      ))}
    </View>
  );
}
