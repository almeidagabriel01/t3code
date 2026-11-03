import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Handlers = {
  onMenuInteractionStart?: () => void;
  onOpenMenu?: () => void;
  onCloseMenu?: () => void;
};
type RowProps = {
  onTouchStart?: (event: unknown) => void;
  onPress?: (event: unknown) => void;
};

const captured = vi.hoisted(() => ({ menu: {} as Handlers, row: {} as RowProps }));

vi.mock("@react-native-menu/menu", () => ({
  MenuView: (props: Handlers & { children?: unknown }) => {
    captured.menu = props;
    return props.children;
  },
}));
vi.mock("uniwind", () => ({ withUniwind: (component: unknown) => component }));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../lib/menu-action-colors", () => ({
  withMenuActionIconColors: (actions: unknown) => actions,
}));

import { Menu } from "./Menu";

function Row(props: RowProps) {
  captured.row = props;
  return null;
}

function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const onPress = vi.fn();
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <Menu actions={[]} shouldOpenOnLongPress>
        <Row onPress={onPress} />
      </Menu>,
    ),
  );
  const tap = () => {
    captured.row.onTouchStart?.({});
    captured.menu.onMenuInteractionStart?.();
    captured.row.onPress?.({ nativeEvent: { identifier: 1 }, persist: () => {} });
  };
  return {
    onPress,
    tap,
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

it("still runs a tap UIKit prepared a menu for but never showed or ended", () => {
  using screen = setup();
  screen.tap();
  expect(screen.onPress).not.toHaveBeenCalled();
  vi.advanceTimersByTime(250);
  expect(screen.onPress).toHaveBeenCalledTimes(1);
});

it("drops the tap when the long press opened the menu", () => {
  using screen = setup();
  screen.tap();
  captured.menu.onOpenMenu?.();
  captured.menu.onCloseMenu?.();
  vi.advanceTimersByTime(250);
  expect(screen.onPress).not.toHaveBeenCalled();
});

it("runs the tap once when UIKit cancels the menu before the fallback", () => {
  using screen = setup();
  screen.tap();
  captured.menu.onCloseMenu?.();
  expect(screen.onPress).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(250);
  expect(screen.onPress).toHaveBeenCalledTimes(1);
});
