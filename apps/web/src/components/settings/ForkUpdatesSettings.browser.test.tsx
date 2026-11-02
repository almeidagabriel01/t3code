import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  fakeForkUpdate,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { ForkUpdatesSettingsPanel } from "./ForkUpdatesSettings";

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

installFakeEnvironment([threadWithHistory("thread-a", 2)]);
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const status = (overrides: Partial<typeof fakeForkUpdate.status>) => {
  fakeForkUpdate.status = { ...fakeForkUpdate.status, behind: 3, ...overrides };
  fakeForkUpdate.commands = [];
};

async function openPanel() {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(
    <AppAtomRegistryProvider>
      <ForkUpdatesSettingsPanel />
    </AppAtomRegistryProvider>,
    { container },
  );
}

// One mount walks the states: the whole app is slow to boot, and Check now refetches the status.
it("offers the one action that moves the fork forward", async () => {
  status({ path: "/elsewhere/fork", wouldConflict: false });
  await using _screen = await openPanel();
  const recheck = async () => userEvent.click(page.getByRole("button", { name: "Check now" }));

  await expect.element(page.getByRole("button", { name: "Add project" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Update now" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Add project" }));
  await vi.waitFor(() =>
    expect(fakeForkUpdate.commands).toMatchObject([
      { type: "project.create", workspaceRoot: "/elsewhere/fork", title: "fork" },
    ]),
  );

  status({ path: "/workspace/render", wouldConflict: false });
  await recheck();
  await expect.element(page.getByRole("button", { name: "Update now" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add project" })).not.toBeInTheDocument();

  status({ wouldConflict: true, conflictFiles: ["apps/web/src/a.ts", "package.json"] });
  await recheck();
  await expect.element(page.getByRole("button", { name: "Resolve with agent" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Update now" })).not.toBeInTheDocument();
  await expect
    .element(page.getByText("would conflict in 2 files", { exact: false }).first())
    .toBeVisible();
  await expect.element(page.getByText("package.json")).not.toBeVisible();
  await userEvent.click(page.getByText("Show conflicting files"));
  await expect.element(page.getByText("package.json")).toBeVisible();

  status({ available: false, behind: 0 });
  await recheck();
  await expect
    .element(page.getByText("No fork checkout with an upstream remote", { exact: false }))
    .toBeVisible();
});
