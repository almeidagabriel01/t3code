import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import {
  fakeTelegram,
  installFakeEnvironment,
  resetFakeTelegram,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { TelegramSettingsPanel } from "./TelegramSettings";

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
  telegramChannel: true,
  scopes: [AuthOrchestrationReadScope],
});
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

it("shows the status and disables every change without permission", async () => {
  resetFakeTelegram({
    enabled: true,
    tokenConfigured: true,
    allowedUserIds: ["111"],
    status: "running",
  });
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <TelegramSettingsPanel />
    </AppAtomRegistryProvider>,
    { container },
  );
  await expect.element(page.getByText("Connected", { exact: false })).toBeVisible();
  await expect.element(page.getByRole("switch", { name: "Use Telegram" })).toBeDisabled();
  await expect.element(page.getByLabelText("Bot token")).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Remove token" })).toBeDisabled();
  await expect.element(page.getByLabelText("Telegram user ids")).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Remove 111" })).toBeDisabled();
  expect(fakeTelegram.configures).toEqual([]);
});
