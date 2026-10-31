import { createMemoryHistory } from "@tanstack/react-router";
import type { Assistant, AssistantId, ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  fakeAssistants,
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

installFakeEnvironment([threadWithHistory("thread-a", 2)], { assistants: true });
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const assistant = (id: string, name: string, overrides: Partial<Assistant> = {}): Assistant => ({
  id: id as AssistantId,
  handle: id,
  name,
  projectId: "project-1" as ProjectId,
  instructions: "",
  toolAccess: "full",
  isDefault: false,
  threadId: `assistant:${id}:1` as ThreadId,
  generation: 1,
  budget: null,
  archivedAt: null,
  createdAt: "2026-03-17T19:00:00.000Z",
  updatedAt: "2026-03-17T19:00:00.000Z",
  ...overrides,
});

async function openApp(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(<AppRoot router={router} />, { container, router: false });
}

it("lists assistants in Settings with an Archived section", async () => {
  fakeAssistants.items = [
    assistant("jarvis", "Jarvis", { isDefault: true }),
    assistant("old", "Retired", { archivedAt: "2026-03-18T00:00:00.000Z" }),
  ];
  await using _screen = await openApp("/settings/assistants");
  await expect.element(page.getByRole("button", { name: "New assistant" })).toBeVisible();
  await expect.element(page.getByText("Archived", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Unarchive" })).toBeVisible();
});
