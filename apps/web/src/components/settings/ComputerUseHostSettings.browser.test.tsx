import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  fakeMacPermissions,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { Route } from "../../routes/_chat.settings.computer-use";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const NO_PERMISSIONS = {
  supported: false,
  screenRecording: "unknown",
  accessibility: "unknown",
  automation: "unknown",
} as const;

/** Where the sidebar and settings search list the page: its availability decides both. */
function PageListing() {
  const listed = useAvailableSettingsSearchItems().some((item) => item.id === "computer-use");
  return <output>{listed ? "Page listed" : "Page hidden"}</output>;
}

async function openPanel() {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  // The route's own component, so the page the URL opens is the one under test.
  const Panel = Route.options.component!;
  return render(
    <AppAtomRegistryProvider>
      <PageListing />
      <Panel />
    </AppAtomRegistryProvider>,
    { container },
  );
}

it("shows what a Linux Wayland host can do, with each limit in words", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("thread-a", 2)]);
  fakeMacPermissions.reads = [];
  fakeMacPermissions.permissions = {
    ...NO_PERMISSIONS,
    host: {
      os: "linux",
      display: "wayland",
      capabilities: [
        { key: "elements", state: "available", detail: "Reads an app's controls." },
        { key: "screenshot", state: "consent", detail: "Your desktop asks you first." },
        { key: "pointer", state: "unavailable", detail: "Wayland cannot aim the pointer." },
        { key: "keyboard", state: "limited", detail: "GNOME sessions only." },
      ],
    },
  };
  await using _screen = await openPanel();

  await expect.element(page.getByText("Linux, Wayland session")).toBeVisible();
  await expect.element(page.getByText("Page listed")).toBeVisible();
  for (const text of [
    "App controls",
    "Supported",
    "Screenshots",
    "Asks you first",
    "Clicks by screen position",
    "Not supported",
    "Wayland cannot aim the pointer.",
    "Key presses",
    "Limited",
  ]) {
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
  }
  // A Windows or Linux host has nothing to grant, and its page never asks for Automation.
  await expect
    .element(page.getByRole("button", { name: "Open System Settings" }))
    .not.toBeInTheDocument();
  expect(fakeMacPermissions.reads).toEqual([false]);
});

it("says so when the host is too old to report, and when only a Mac is connected", async () => {
  {
    using _environment = installFakeEnvironment([threadWithHistory("thread-a", 2)]);
    fakeMacPermissions.permissions = NO_PERMISSIONS;
    await using _screen = await openPanel();
    await expect.element(page.getByText("Not reported")).toBeVisible();
  }
  using _environment = installFakeEnvironment([threadWithHistory("thread-a", 2)], { mac: true });
  await using _screen = await openPanel();
  await expect.element(page.getByText("Not available")).toBeVisible();
  await expect.element(page.getByText("Page hidden")).toBeVisible();
});
