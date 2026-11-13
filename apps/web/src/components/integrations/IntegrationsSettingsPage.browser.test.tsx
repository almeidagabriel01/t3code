import { createMemoryHistory } from "@tanstack/react-router";
import type { IntegrationCatalogEntry } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { openCommandPalette } from "~/commandPaletteBus";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  fakeIntegrations,
  installFakeEnvironment,
  publishIntegrations,
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

installFakeEnvironment([threadWithHistory("thread-a", 1)], { integrations: true });
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const notion = {
  id: "notion",
  name: "Notion",
  category: "docs",
  description: "Search and edit pages.",
  docsUrl: "https://example.com",
  server: { transport: "http", url: "https://notion.example.com/mcp" },
  auth: { kind: "oauth", registration: "dynamic" },
  match: { urls: [], packages: [], names: [] },
} as IntegrationCatalogEntry;

async function openApp(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

it("Settings → Integrations lists the environment's catalog and connects through the server", async () => {
  publishIntegrations({
    catalog: [notion],
    integrations: [],
    ownApps: [],
    loopbackRedirectUri: "http://127.0.0.1:43110/integrations/callback",
    detected: [],
    detectionSources: [],
  });
  fakeIntegrations.begun = [];
  using _open = vi.spyOn(window, "open").mockReturnValue(null);
  const { screen } = await openApp("/settings/integrations");
  await using _screen = screen;
  await expect
    .element(page.getByRole("treeitem", { name: "Integrations" }))
    .toHaveAttribute("aria-current", "page");
  await expect.element(page.getByText("Search and edit pages.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Connect" }));
  await vi.waitFor(() =>
    expect(fakeIntegrations.begun).toEqual([
      { catalogId: "notion", client: { kind: "web", origin: window.location.origin } },
    ]),
  );
});

it("an agent's link opens the entry: its detail once connected, otherwise a search for it", async () => {
  publishIntegrations({
    catalog: [notion, { ...notion, id: "linear", name: "Linear", description: "Issues." }],
    integrations: [
      {
        name: "linear",
        catalogId: "linear",
        auth: "oauth",
        status: "connected",
        availability: "assistants",
      },
    ],
    ownApps: [],
    loopbackRedirectUri: "http://127.0.0.1:43110/integrations/callback",
    detected: [],
    detectionSources: [],
  });
  {
    const { screen } = await openApp("/settings/integrations?entry=linear");
    await using _screen = screen;
    await expect.element(page.getByRole("dialog").getByText("Linear")).toBeVisible();
  }
  const { screen } = await openApp("/settings/integrations?entry=notion");
  await using _screen = screen;
  await expect
    .element(page.getByRole("searchbox", { name: "Search integrations" }))
    .toHaveValue("Notion");
  expect(page.getByText("Issues.").query()).toBeNull();
});

it("the command palette opens Integrations", async () => {
  const { screen, router } = await openApp("/settings/general");
  await using _screen = screen;
  await expect.element(page.getByRole("treeitem", { name: "Integrations" })).toBeVisible();
  openCommandPalette({ query: "Integrations" });
  await userEvent.click(page.getByRole("option", { name: /^Integrations/ }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/integrations"));
});
