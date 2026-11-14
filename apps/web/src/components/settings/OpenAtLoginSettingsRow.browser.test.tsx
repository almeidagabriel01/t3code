import type { DesktopOpenAtLoginState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import "../../index.css";
import { OpenAtLoginSettingsRow } from "./OpenAtLoginSettingsRow";

const state = (fields: Partial<DesktopOpenAtLoginState>): DesktopOpenAtLoginState => ({
  enabled: true,
  platform: "darwin",
  status: "enabled",
  ...fields,
});

// The app shell reads these on mount.
const shellBridge = {
  getLocalEnvironmentEnabled: () => true,
  getLocalEnvironmentBootstraps: () => [],
};

it("shows the system's state, refreshes on focus and fixes approval in System Settings", async () => {
  const getOpenAtLogin = vi.fn(async () => state({ status: "requires-approval" }));
  const setOpenAtLogin = vi.fn(async (enabled: boolean) =>
    state({ enabled, status: enabled ? "enabled" : "not-registered" }),
  );
  const openLoginItemsSettings = vi.fn(async () => true);
  using _bridge = stubGlobal("desktopBridge", {
    ...shellBridge,
    getOpenAtLogin,
    setOpenAtLogin,
    openLoginItemsSettings,
  });
  await using screen = await render(<OpenAtLoginSettingsRow />, {
    // The row needs no navigation.
    router: false,
  });

  const toggle = screen.getByRole("switch", { name: "Open at login" });
  await expect.element(toggle).toBeChecked();
  await expect.element(screen.getByText(/Turned off in System Settings/)).toBeVisible();
  await screen.getByRole("button", { name: "Open System Settings" }).click();
  expect(openLoginItemsSettings).toHaveBeenCalledOnce();

  getOpenAtLogin.mockResolvedValue(state({ status: "enabled" }));
  await act(() => window.dispatchEvent(new Event("focus")));
  await expect.element(screen.getByText(/Turned off in System Settings/)).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Open System Settings" }))
    .not.toBeInTheDocument();

  await toggle.click();
  expect(setOpenAtLogin).toHaveBeenLastCalledWith(false);
  await expect.element(toggle).not.toBeChecked();
});

it("says so when the change fails", async () => {
  using _bridge = stubGlobal("desktopBridge", {
    ...shellBridge,
    getOpenAtLogin: vi.fn(async () => state({ enabled: false, status: "not-registered" })),
    setOpenAtLogin: vi.fn(async () => {
      throw new Error("denied");
    }),
    openLoginItemsSettings: vi.fn(async () => true),
  });
  await using screen = await render(<OpenAtLoginSettingsRow />, { router: false });

  const toggle = screen.getByRole("switch", { name: "Open at login" });
  await expect.element(toggle).not.toBeChecked();
  await toggle.click();
  await expect.element(screen.getByText("Couldn't change this setting.")).toBeVisible();
  await expect.element(toggle).toBeEnabled();
});

it("renders nothing where the desktop has no login items", async () => {
  using _bridge = stubGlobal("desktopBridge", {
    ...shellBridge,
    getOpenAtLogin: vi.fn(async () => null),
  });
  await using screen = await render(<OpenAtLoginSettingsRow />, { router: false });
  await expect.element(screen.getByRole("switch")).not.toBeInTheDocument();
});
