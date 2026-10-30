import { createMemoryHistory } from "@tanstack/react-router";
import type { Decision, DecisionId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  fakeDecisions,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// Only the socket is fake, as in appScenarios: the page, hooks, atoms and commands are the app's.
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

const thread = threadWithHistory("thread-a", 2);
installFakeEnvironment([thread], { decisions: true });
// Desktop-sized, so the sidebar and composer lay out as they do in the app.
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const decision: Decision = {
  id: "d1" as DecisionId,
  fromThreadId: thread.id as ThreadId,
  threadTitle: "Nightly migration",
  title: "Pick a migration strategy",
  context: "",
  options: [
    { id: "online", label: "Online" },
    { id: "offline", label: "Offline" },
  ],
  status: "open",
  createdAt: "2026-03-17T19:00:00.000Z",
};

it("shows a thread's decision as one row that expands to the card and back", async () => {
  fakeDecisions.items = [decision];
  fakeDecisions.calls = [];
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using _screen = await render(<AppRoot router={router} />, { container, router: false });

  // The transcript loads first, so the banner sits beside real content and is not remounted.
  await expect.element(page.getByText(`Answer 1 for ${thread.id}.`)).toBeVisible();
  const banner = page.getByText("Decision needed:");
  await expect.element(banner).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Answer" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Review" }));
  await userEvent.click(page.getByText("Online"));
  await userEvent.click(page.getByRole("button", { name: "Dismiss" }));
  await vi.waitFor(() =>
    expect(fakeDecisions.calls).toEqual([
      { method: "decisions.dismiss", input: { decisionId: "d1" } },
    ]),
  );
  await expect.element(banner).not.toBeInTheDocument();
});
