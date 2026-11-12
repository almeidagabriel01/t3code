import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo", () => ({
  requireNativeView: () => (props: { labels: string[] }) => (
    <p data-native>{props.labels.join("|")}</p>
  ),
}));
vi.mock("react-native", () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: "ios" },
  View: (props: { children?: ReactNode; style?: { minHeight?: number } }) => (
    <div data-min-height={props.style?.minHeight}>{props.children}</div>
  ),
  Pressable: (props: { accessibilityLabel: string; onPress: () => void; children?: ReactNode }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: () => null },
  useAnimatedStyle: () => ({}),
  useDerivedValue: () => ({ value: 0 }),
  useReducedMotion: () => false,
  withTiming: (value: number) => value,
}));
vi.mock("./AppText", () => ({
  AppText: (props: { textRole: string; children?: ReactNode }) => (
    <span data-role={props.textRole}>{props.children}</span>
  ),
}));
vi.mock("./AppSymbol", () => ({ SymbolView: (props: { name: string }) => <i>{props.name}</i> }));
vi.mock("./useControlTheme", () => ({
  useControlTheme: () => ({ colors: {}, colorScheme: "light", themeId: "default" }),
}));
vi.mock("./segmentedControlColors", () => ({
  segmentedControlColors: () => ({
    trackColor: "t",
    selectedColor: "s",
    selectedTextColor: "x",
    mutedColor: "m",
  }),
}));

import { SegmentedControl } from "./SegmentedControl";

async function mount(icons: boolean) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  const onSelect = vi.fn();
  const options = [
    { value: "a", label: "Board", ...(icons ? { icon: "square.grid.2x2" as const } : {}) },
    { value: "b", label: "Memory", ...(icons ? { icon: "brain" as const } : {}) },
  ];
  await act(async () =>
    root.render(<SegmentedControl options={options} selected="a" onSelect={onSelect} />),
  );
  return { host, onSelect, unmount: () => act(() => root.unmount()) };
}

describe("SegmentedControl", () => {
  it("stacks each icon over a short caption in a taller flat control, even on iOS", async () => {
    const view = await mount(true);
    expect(view.host.querySelector("[data-native]")).toBeNull();
    expect([...view.host.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "square.grid.2x2Board",
      "brainMemory",
    ]);
    expect(view.host.querySelector("[data-role]")?.getAttribute("data-role")).toBe("caption");
    expect(view.host.querySelector("[data-min-height]")?.getAttribute("data-min-height")).toBe(
      "52",
    );
    act(() => view.host.querySelector<HTMLButtonElement>('[aria-label="Memory"]')!.click());
    expect(view.onSelect).toHaveBeenCalledWith("b");
    await view.unmount();
  });

  it("keeps the native iOS control for labels alone", async () => {
    const view = await mount(false);
    expect(view.host.querySelector("[data-native]")?.textContent).toBe("Board|Memory");
    await view.unmount();
  });
});
