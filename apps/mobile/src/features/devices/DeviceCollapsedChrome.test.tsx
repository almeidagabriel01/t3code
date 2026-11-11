import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/GlassSurface", () => ({ GlassSurface: Children }));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: (props: { accessibilityLabel: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/SheetHeader", () => ({
  SheetCloseButton: (props: { accessibilityLabel: string; onClose: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onClose} />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress} />
  ),
}));

import { DeviceCollapsedChrome } from "./DeviceCollapsedChrome";

async function setup(held: boolean, canHold = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const handlers = { onClose: vi.fn(), onShowControls: vi.fn(), onHandBack: vi.fn() };
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <DeviceCollapsedChrome top={12} offsetX={0} held={held} canHold={canHold} {...handlers} />,
    ),
  );
  return {
    container,
    handlers,
    button: (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

describe("full-screen device viewer with its controls hidden", () => {
  it("keeps the held banner and its hand back while the user holds the device", async () => {
    using screen = await setup(true);
    expect(screen.container.textContent).toContain("You are in control");
    await act(async () => screen.button("Hand back")!.click());
    expect(screen.handlers.onHandBack).toHaveBeenCalledOnce();
    await act(async () => screen.button("Show device controls")!.click());
    expect(screen.handlers.onShowControls).toHaveBeenCalledOnce();
  });

  it("shows no banner for a device the agent drives, and locks hand back without permission", async () => {
    {
      using screen = await setup(false);
      expect(screen.container.textContent).not.toContain("You are in control");
    }
    using screen = await setup(true, false);
    expect(screen.button("Hand back")!.disabled).toBe(true);
  });
});
