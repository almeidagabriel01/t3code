import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  buildActivityEntries,
  selectSidebarMarkReadTargets,
  type ActivityRank,
} from "@t3tools/client-runtime/state/thread-activity";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

const NO_DELEGATED: ReadonlySet<string> = new Set();
const NO_HOLDS = new Map<string, never>();
const GROUPS: readonly { rank: ActivityRank; heading: string }[] = [
  { rank: 0, heading: "Needs you" },
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
}) {
  const openDecisionThreadKeys = useOpenDecisionThreadKeys();
  const selectDetail = useSelectWorkspaceDetail();
  const operable = useEnvironmentsWithScope(props.threads, AuthOrchestrationOperateScope);
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const entries = buildActivityEntries({
    // Older servers keep no visit time, so a finished run would never clear.
    threads: props.threads.map((thread) =>
      thread.lastVisitedAt === undefined ? { ...thread, latestRun: null } : thread,
    ),
    delegatedUnderParent: NO_DELEGATED,
    localLastVisitedAtByKey: {},
    holds: NO_HOLDS,
    releases: NO_DELEGATED,
    now: props.now,
    openDecisionThreadKeys,
  }).filter((entry) => props.includeWorking || entry.rank !== 1);
  if (entries.length === 0) return null;

  const markAllRead = async () => {
    const wokeAtByKey = new Map(
      entries.map((entry) => [entry.key, threadWokeAt(entry.thread, { now: props.now })]),
    );
    const targets = selectSidebarMarkReadTargets({
      threads: entries.map((entry) => entry.thread),
      localLastVisitedAtByKey: {},
      wokeAtByKey,
      canOperate: (thread) => operable.has(thread.environmentId),
    });
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

  return (
    <View className="gap-1 pb-3 pt-2" style={{ paddingHorizontal: props.gutter }}>
      {GROUPS.map(({ rank, heading }) => {
        const group = entries.filter((entry) => entry.rank === rank);
        if (group.length === 0) return null;
        return (
          <View key={rank} className="gap-0.5">
            <View className="min-h-8 flex-row items-center justify-between">
              <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
                {heading} · {group.length}
              </Text>
              {rank === 2 ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => void markAllRead()}
                  className="active:opacity-70"
                >
                  <Text className="font-t3-medium text-xs text-foreground-secondary">
                    Mark all as read
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {group.map((entry) => (
              <Pressable
                key={entry.key}
                accessibilityRole="button"
                onPress={() =>
                  // By id, not from a thread list: the sidebar sits outside any navigator screen.
                  selectDetail({
                    name: "Thread",
                    params: {
                      environmentId: String(entry.thread.environmentId),
                      threadId: String(entry.thread.id),
                    },
                  })
                }
                className="min-h-10 justify-center active:opacity-70"
              >
                <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
                  {entry.thread.title}
                </Text>
              </Pressable>
            ))}
          </View>
        );
      })}
    </View>
  );
}
