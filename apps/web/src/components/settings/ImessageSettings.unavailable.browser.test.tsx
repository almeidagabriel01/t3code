import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

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

// No iMessage capability: a non-Mac or older server.
installFakeEnvironment([threadWithHistory("thread-a", 2)]);
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

it("hides iMessage from the settings navigation and explains the page", async () => {
  const router = getRouter(createMemoryHistory({ initialEntries: ["/settings/imessage"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using _screen = await render(<AppRoot router={router} />, { container, router: false });
  await expect.element(page.getByText("iMessage is not available")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect.element(nav.getByText("Assistants")).toBeVisible();
  expect(nav.getByText("iMessage").query()).toBeNull();
});
