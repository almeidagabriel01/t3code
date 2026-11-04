import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
import { MacPermissionsSettingsPanel } from "./MacPermissionsSettings";

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

async function openPanel() {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(
    <AppAtomRegistryProvider>
      <MacPermissionsSettingsPanel />
    </AppAtomRegistryProvider>,
    { container },
  );
}

it("shows each permission, opens its System Settings pane and checks again", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("thread-a", 2)], { mac: true });
  fakeMacPermissions.opened = [];
  await using _screen = await openPanel();

  await expect.element(page.getByText("Screen Recording")).toBeVisible();
  await expect.element(page.getByText("Granted")).toBeVisible();
  await expect.element(page.getByText("Not granted")).toBeVisible();
  await expect.element(page.getByText("Unknown")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Open System Settings" }).nth(1));
  await vi.waitFor(() => expect(fakeMacPermissions.opened).toEqual(["accessibility"]));

  fakeMacPermissions.permissions = { ...fakeMacPermissions.permissions, accessibility: "granted" };
  await userEvent.click(page.getByRole("button", { name: "Check again" }));
  await expect.element(page.getByText("Not granted")).not.toBeInTheDocument();
});

it("says so when no Mac is connected", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("thread-a", 2)]);
  await using _screen = await openPanel();
  await expect.element(page.getByText("Not available")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Open System Settings" }))
    .not.toBeInTheDocument();
});
