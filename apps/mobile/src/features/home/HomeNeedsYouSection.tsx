import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  selectActivityClear,
  selectSidebarMarkReadTargets,
  type ActivityRank,
} from "@t3tools/client-runtime/state/thread-activity";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { Fragment, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildHomeActivityEntries } from "./homeActivityEntries";
import {
  buildThreadListV2ListItems,
  type ThreadListV2ThreadListItem,
} from "../threads/threadListV2";

const GROUPS: readonly { rank: ActivityRank; heading: string }[] = [
  { rank: 0, heading: "Waiting for you" },
  { rank: 1, heading: "Working" },
  { rank: 2, heading: "Unread" },
];

/**
 * Threads that need the user, in the order of web's Activity page. With the working shelf on,
 * working threads stay in the shelf, so they are left out here instead of listed twice.
 */
export function HomeNeedsYouSection(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly includeWorking: boolean;
  readonly gutter: number;
  readonly sidebar?: boolean;
  /** Renders a thread as the app's list row, with the handlers of the list that hosts this section. */
  readonly renderRow: (item: ThreadListV2ThreadListItem) => ReactNode;
}) {
  const openDecisionThreadKeys = useOpenDecisionThreadKeys();
  const operable = useEnvironmentsWithScope(props.threads, AuthOrchestrationOperateScope);
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const entries = buildHomeActivityEntries({
    threads: props.threads,
    now: props.now,
    openDecisionThreadKeys,
  }).filter((entry) => props.includeWorking || entry.rank !== 1);
  if (entries.length === 0) return null;
  const muted = props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary";

  const wokeAtByKey = new Map(
    entries.map((entry) => [entry.key, threadWokeAt(entry.thread, { now: props.now })]),
  );
  const canOperate = (thread: EnvironmentThreadShell) => operable.has(thread.environmentId);
  const threads = entries.map((entry) => entry.thread);
  const markRead = async (targets: ReadonlyArray<EnvironmentThreadShell>) => {
    let failed = false;
    for (const thread of targets) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const result = await visitThread({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, visitedAt: wokeAtByKey.get(key) ?? props.now },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) failed = true;
    }
    if (failed) Dialog.alert("Could not mark every thread as read");
  };
  const markAllRead = () =>
    markRead(
      selectSidebarMarkReadTargets({
        threads,
        localLastVisitedAtByKey: {},
        wokeAtByKey,
        canOperate,
      }),
    );
  // No holds here, so rows leave as soon as they are read and only the visits remain.
  const clearRead = () =>
    markRead(
      selectActivityClear({ threads, localLastVisitedAtByKey: {}, wokeAtByKey, canOperate })
        .markRead,
    );

  const groups = GROUPS.map((group) => ({
    ...group,
    items: buildThreadListV2ListItems({
      items: entries
        .filter((entry) => entry.rank === group.rank)
        .map(({ thread, key }) => ({
          thread,
          variant: "card" as const,
          snoozed: false,
          pinned: thread.pinnedAt != null,
          wokeAt: wokeAtByKey.get(key) ?? null,
          isLast: false,
        })),
      pendingTasks: [],
    }).filter((item) => item.type === "v2-thread"),
  })).filter((group) => group.items.length > 0);
  const menuActions: MenuAction[] = [
    { id: "markAll", title: "Mark all as read", image: "checkmark.circle" },
    { id: "clear", title: "Clear read", image: "xmark" },
  ];

  return (
    <View className="pb-3 pt-2">
      <View className="min-h-9 flex-row items-center" style={{ paddingHorizontal: props.gutter }}>
        <Text className={cn("flex-1 font-t3-bold text-2xs uppercase tracking-[1.1px]", muted)}>
          Needs you
        </Text>
        {groups.some((group) => group.rank === 2) ? (
          <Menu
            actions={menuActions}
            onPressAction={({ nativeEvent }) =>
              void (nativeEvent.event === "markAll" ? markAllRead() : clearRead())
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Unread actions"
              hitSlop={8}
              className="size-9 items-center justify-center rounded-full active:opacity-70"
            >
              <SymbolView
                name="ellipsis"
                size={18}
                tintColorClassName={
                  props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"
                }
                type="monochrome"
              />
            </Pressable>
          </Menu>
        ) : null}
      </View>
      {groups.map(({ rank, heading, items }) => (
        <View key={rank}>
          {groups.length > 1 ? (
            <Text
              className={cn("px-3 pb-1 pt-2 text-xs font-t3-medium", muted)}
              style={{ marginHorizontal: props.gutter }}
            >
              {heading} · {items.length}
            </Text>
          ) : null}
          {items.map((item) => (
            <Fragment key={item.key}>{props.renderRow(item)}</Fragment>
          ))}
        </View>
      ))}
    </View>
  );
}
