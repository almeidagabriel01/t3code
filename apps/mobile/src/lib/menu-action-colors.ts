import type { MenuAction } from "@react-native-menu/menu";

// MenuView's iOS bridge treats an omitted imageColor as transparent, and a set one is drawn as-is
// even on a disabled action, so a disabled action needs its own muted color to read as disabled.
export function withMenuActionIconColors(
  actions: readonly MenuAction[],
  colors: {
    readonly icon: MenuAction["imageColor"];
    readonly destructiveIcon: MenuAction["imageColor"];
    readonly disabledIcon: MenuAction["imageColor"];
  },
): MenuAction[] {
  return actions.map((action) => ({
    ...action,
    ...(action.image
      ? {
          imageColor:
            action.imageColor ??
            (action.attributes?.disabled
              ? colors.disabledIcon
              : action.attributes?.destructive
                ? colors.destructiveIcon
                : colors.icon),
        }
      : {}),
    ...(action.subactions
      ? { subactions: withMenuActionIconColors(action.subactions, colors) }
      : {}),
  }));
}
