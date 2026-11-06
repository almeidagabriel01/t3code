import { createMemoryHistory } from "@tanstack/react-router";
import type {
  Assistant,
  AssistantId,
  AssistantTeam,
  AssistantTeamId,
  AssistantTeamMessage,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { getRouter } from "~/router";
import { assistantTeamActivityAtom, assistantTeamDialogAtom } from "./assistantTeamState";
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
  name,
  projectId: "project-1" as ProjectId,
  instructions: "",
  toolAccess: "full",
  isDefault: false,
  threadId: `assistant:${id}:1` as ThreadId,
  generation: 1,
  role: "",
  reportsTo: null,
  budget: null,
  askBeforeActing: false,
  icon: null,
  mcpServers: [],
  autonomy: { mode: "reply-only", rules: null, projectIds: null, channels: null },
  archivedAt: null,
  createdAt: "2026-03-17T19:00:00.000Z",
  updatedAt: "2026-03-17T19:00:00.000Z",
});

const team: AssistantTeam = {
  id: "t1" as AssistantTeamId,
  name: "Growth",
  memberIds: ["ana", "bob"] as AssistantId[],
  leaderId: "bob" as AssistantId,
  leaderTitle: "CFO",
  createdAt: "2026-03-17T19:00:00.000Z",
  updatedAt: "2026-03-17T19:00:00.000Z",
};

const message = (n: number, from: string, to: string, text: string): AssistantTeamMessage => ({
  messageId: `m${n}`,
  at: `2026-03-17T19:00:0${n}.000Z`,
  fromAssistantId: from as AssistantId,
  toAssistantId: to as AssistantId,
  fromThreadId: `assistant:${from}:1` as ThreadId,
  toThreadId: `assistant:${to}:1` as ThreadId,
  text,
  truncated: false,
});

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

async function openApp(path: string) {
  appAtomRegistry.set(assistantTeamDialogAtom, null);
  appAtomRegistry.set(assistantTeamActivityAtom, null);
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return render(<AppRoot router={router} />, { container, router: false });
}

it("creates a team with members, a leader and its title", async () => {
  fakeTeamEdits.creates = [];
  publishAssistants([assistant("ana", "Ana"), assistant("bob", "Bob"), assistant("cy", "Cy")]);
  await using _screen = await openApp("/settings/assistants");
  await userEvent.click(page.getByRole("button", { name: "New team" }));
  await userEvent.fill(page.getByLabelText("Name"), "Money");
  // The title field only exists once there is a leader.
  expect(page.getByLabelText("Leader title").query()).toBeNull();
  await userEvent.click(page.getByRole("checkbox", { name: "Ana" }));
  await expect.element(page.getByRole("button", { name: "Create team" })).toBeDisabled();
  await userEvent.click(page.getByRole("checkbox", { name: "Bob" }));
  await userEvent.click(page.getByRole("combobox", { name: "Leader" }));
  await userEvent.click(page.getByRole("option", { name: "Bob" }));
  await userEvent.fill(page.getByLabelText("Leader title"), "CFO");
  await userEvent.click(page.getByRole("button", { name: "Create team" }));
  await eventually(() =>
    expect(fakeTeamEdits.creates).toMatchObject([
      { name: "Money", memberIds: ["ana", "bob"], leaderId: "bob", leaderTitle: "CFO" },
    ]),
  );
});

it("the team view lists only the member-to-member messages, with the leader's title", async () => {
  fakeTeamEdits.messages = [
    message(1, "ana", "bob", "Are the Q3 numbers final?"),
    message(2, "bob", "ana", "Yes, signed off."),
  ];
  publishAssistants([assistant("ana", "Ana"), assistant("bob", "Bob")], [team]);
  await using _screen = await openApp("/settings/assistants");
  await expect.element(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await expect.element(page.getByText("Bob (CFO)", { exact: false })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Activity" }));
  await expect.element(page.getByText("Are the Q3 numbers final?")).toBeVisible();
  await expect.element(page.getByText("Yes, signed off.")).toBeVisible();
  await expect.element(page.getByText("CFO", { exact: true }).first()).toBeVisible();
  expect(page.getByTestId("team-message").elements()).toHaveLength(2);
});

it("the sidebar lists teams and opens the same view", async () => {
  fakeTeamEdits.messages = [];
  publishAssistants([assistant("ana", "Ana"), assistant("bob", "Bob")], [team]);
  await using _screen = await openApp("/");
  await userEvent.click(page.getByTestId("sidebar-team-row"));
  await expect
    .element(page.getByText("No messages between members yet", { exact: false }))
    .toBeVisible();
});
