import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { SymbolView } from "./AppSymbol";
import { Menu } from "./Menu";

/** A row's always-visible ⋯ button; place it beside the row's pressable, never inside it. */
export function RowMenuButton(props: {
  readonly label: string;
  readonly actions: MenuAction[];
  readonly onAction: (id: string) => void;
  readonly sidebar?: boolean;
}) {
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        hitSlop={6}
        className="size-9 items-center justify-center rounded-full active:opacity-70"
      >
        <SymbolView
          name="ellipsis"
          size={16}
          tintColorClassName={
            props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"
          }
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}
