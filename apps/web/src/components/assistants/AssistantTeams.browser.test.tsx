import { createMemoryHistory } from "@tanstack/react-router";
import type { Assistant, AssistantId, ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { getRouter } from "~/router";
import { assistantTeamDialogAtom } from "./assistantTeamState";
import {
  fakeTeamEdits,
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

const assistant = (id: string, name: string): Assistant => ({
  id: id as AssistantId,
  handle: id,
  projectIds: [],
  name,
  projectId: "project-1" as ProjectId,
  instructions: "",
  toolAccess: "full",
  isDefault: false,
  threadId: `assistant:${id}:1` as ThreadId,
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
});

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

async function openApp(path: string) {
  appAtomRegistry.set(assistantTeamDialogAtom, null);
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(<AppRoot router={router} />, { container, router: false });
}

it("creates a team with members and a lead", async () => {
  fakeTeamEdits.creates = [];
  publishAssistants([assistant("ana", "Ana"), assistant("bob", "Bob"), assistant("cy", "Cy")]);
  await using _screen = await openApp("/settings/assistants");
  await userEvent.click(page.getByRole("button", { name: "New group" }));
  await userEvent.fill(page.getByLabelText("Name"), "Money");
  await userEvent.click(page.getByRole("checkbox", { name: "Ana" }));
  // A group may start with a single member.
  await expect.element(page.getByRole("button", { name: "Create group" })).toBeEnabled();
  await userEvent.click(page.getByRole("checkbox", { name: "Bob" }));
  await userEvent.click(page.getByRole("combobox", { name: "Lead" }));
  await userEvent.click(page.getByRole("option", { name: "Bob" }));
  await userEvent.click(page.getByRole("button", { name: "Create group" }));
  await eventually(() =>
    expect(fakeTeamEdits.creates).toMatchObject([
      { name: "Money", memberIds: ["ana", "bob"], leadId: "bob" },
    ]),
  );
});

it("creates an empty group and shows each member's avatar in the list", async () => {
  fakeTeamEdits.creates = [];
  publishAssistants([assistant("ana", "Ana")]);
  await using _screen = await openApp("/settings/assistants");
  await userEvent.click(page.getByRole("button", { name: "New group" }));
  await userEvent.fill(page.getByLabelText("Name"), "Later");
  expect(page.getByRole("checkbox", { name: "Ana" }).element().closest("label")).not.toBeNull();
  expect(
    page
      .getByRole("checkbox", { name: "Ana" })
      .element()
      .closest("label")
      ?.querySelector("[data-assistant-robot]"),
  ).not.toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Create group" }));
  await eventually(() =>
    expect(fakeTeamEdits.creates).toMatchObject([{ name: "Later", memberIds: [], leadId: null }]),
  );
});
