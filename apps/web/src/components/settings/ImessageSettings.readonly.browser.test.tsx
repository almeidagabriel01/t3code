import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import {
  fakeImessage,
  installFakeEnvironment,
  resetFakeImessage,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { ImessageSettingsPanel } from "./ImessageSettings";

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
  imessageChannel: true,
  scopes: [AuthOrchestrationReadScope],
});
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

// The panel alone under the app's atom registry: mounting the whole app per case is slow enough
// to pass the test timeout on a busy machine.
async function openImessage() {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(
    <AppAtomRegistryProvider>
      <ImessageSettingsPanel />
    </AppAtomRegistryProvider>,
    { container },
  );
}

it("disables every change without permission", async () => {
  resetFakeImessage({ selfHandles: ["+15551230000"], allowedHandles: ["a@example.com"] });
  await using _screen = await openImessage();
  await expect.element(page.getByRole("switch", { name: "Use iMessage" })).toBeDisabled();
  await expect.element(page.getByLabelText("Your phone numbers and emails")).toBeDisabled();
  await expect.element(page.getByLabelText("Allowed phone numbers and emails")).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Remove +15551230000" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Remove a@example.com" })).toBeDisabled();
  expect(fakeImessage.configures).toEqual([]);
});
