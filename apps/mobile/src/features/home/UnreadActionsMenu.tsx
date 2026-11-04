import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  selectActivityClear,
  selectSidebarMarkReadTargets,
} from "@t3tools/client-runtime/state/thread-activity";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const MENU_ACTIONS: MenuAction[] = [
  { id: "markAll", title: "Mark all as read", image: "checkmark.circle" },
  { id: "clear", title: "Clear read", image: "xmark" },
];

/** "Mark all as read" and "Clear read" for the finished threads a Home section lists. */
export function UnreadActionsMenu(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly sidebar?: boolean;
}) {
  const operable = useEnvironmentsWithScope(props.threads, AuthOrchestrationOperateScope);
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const wokeAtByKey = new Map(
    props.threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      threadWokeAt(thread, { now: props.now }),
    ]),
  );
  const canOperate = (thread: EnvironmentThreadShell) => operable.has(thread.environmentId);
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
  const threads = props.threads;
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
  return (
    <Menu
      actions={MENU_ACTIONS}
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
  );
}
