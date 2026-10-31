import { createMemoryHistory } from "@tanstack/react-router";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  fakeSlack,
  installFakeEnvironment,
  resetFakeSlack,
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

// A session that can read but not operate.
installFakeEnvironment([threadWithHistory("thread-a", 2)], {
  slackChannel: true,
  scopes: [AuthOrchestrationReadScope],
});
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

it("disables every change without permission", async () => {
  resetFakeSlack({
    hasAppToken: true,
    hasBotToken: true,
    allowedChannelIds: ["C0000000001" as never],
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/settings/slack"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using _screen = await render(<AppRoot router={router} />, { container, router: false });
  await expect.element(page.getByRole("switch", { name: "Use Slack" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Remove tokens" })).toBeDisabled();
  await expect.element(page.getByLabelText("App token")).toBeDisabled();
  await expect.element(page.getByLabelText("Channel ID")).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Remove C0000000001" })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Link your Slack account" }))
    .toBeDisabled();
  expect(fakeSlack.configures).toEqual([]);
});
