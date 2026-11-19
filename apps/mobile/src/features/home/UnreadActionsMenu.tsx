import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useOpenDecisionAtByThreadKey, useOpenDecisionThreadKeys } from "../../state/decisions";
import { buildHomeActivityEntries } from "./homeActivityEntries";
import { useActivityRead } from "./useActivityRead";

const MENU_ACTIONS: MenuAction[] = [
  { id: "markAll", title: "Mark all as read", image: "checkmark.circle" },
  { id: "clear", title: "Clear read", image: "xmark" },
];

/** "Mark all as read" and "Clear read" over the threads Home lists, with the selectors Activity uses on web. */
export function UnreadActionsMenu(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly sidebar?: boolean;
}) {
  const entries = buildHomeActivityEntries({
    threads: props.threads,
    now: props.now,
    openDecisionThreadKeys: useOpenDecisionThreadKeys(),
    openDecisionAtByKey: useOpenDecisionAtByThreadKey(),
  });
  const { markAllRead, clearRead } = useActivityRead(entries, props.now);
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
