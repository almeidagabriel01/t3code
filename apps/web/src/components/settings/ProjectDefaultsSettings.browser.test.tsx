import { createMemoryHistory } from "@tanstack/react-router";
import type { Assistant, AssistantId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  fakeSettings,
  installFakeEnvironment,
  publishAssistants,
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

installFakeEnvironment([threadWithHistory("thread-a", 2)], { assistants: true });
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

it("offers folder model rules for all projects in Threads settings", async () => {
  const router = getRouter(createMemoryHistory({ initialEntries: ["/settings/threads"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using _screen = await render(<AppRoot router={router} />, { container, router: false });
  await expect.element(page.getByText("Model by folder")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Add folder" }));
  await expect.element(page.getByLabelText("Folder")).toBeVisible();
});

it("adds an assistant's model exception from the project's settings, sending only that assistant", async () => {
  fakeSettings.patches = [];
  publishAssistants([
    {
      id: "ada" as AssistantId,
      handle: "ada",
      name: "Ada",
      projectId: PROJECT_ID,
      projectIds: [],
      instructions: "",
      toolAccess: "full",
      isDefault: false,
      threadId: "assistant:ada:1" as ThreadId,
      generation: 1,
      role: "",
      budget: null,
      askBeforeActing: false,
      workspace: "host",
      icon: null,
      avatar: null,
      scope: "all",
      mcpServers: [],
      autonomy: { mode: "reply-only", rules: null, projectIds: null, channels: null },
      archivedAt: null,
      createdAt: "2026-03-17T19:00:00.000Z",
      updatedAt: "2026-03-17T19:00:00.000Z",
    } satisfies Assistant,
  ]);
  const projectKey = buildSidebarProjectSnapshots({
    projects: [
      {
        id: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        title: "render",
        workspaceRoot: "/workspace/render",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-03-17T19:12:28.000Z",
        updatedAt: "2026-03-17T19:12:28.000Z",
      },
    ],
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: ENVIRONMENT_ID,
    resolveEnvironmentLabel: () => null,
  })[0]!.projectKey;
  const router = getRouter(
    createMemoryHistory({
      initialEntries: [`/settings/projects?${new URLSearchParams({ project: projectKey })}`],
    }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using _screen = await render(<AppRoot router={router} />, { container, router: false });
  await userEvent.click(page.getByRole("button", { name: "Add assistant" }));
  await userEvent.click(page.getByRole("combobox", { name: "Assistant" }));
  await userEvent.click(page.getByRole("option", { name: "Ada" }));
  // The page header has an "Add" menu too.
  await userEvent.click(page.getByText("Add", { exact: true }));
  await vi.waitFor(() =>
    expect(fakeSettings.patches.at(-1)).toEqual({
      projectSettingsOverrides: {
        [PROJECT_ID]: {
          assistantModelSelections: { ada: { instanceId: "codex", model: "gpt-5.4" } },
        },
      },
    }),
  );
});
