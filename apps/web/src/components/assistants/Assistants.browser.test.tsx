import { createMemoryHistory } from "@tanstack/react-router";
import {
  DEFAULT_AUTONOMY_SETTINGS,
  ScheduledTaskId,
  type AutonomyWatch,
  type Assistant,
  type AssistantId,
  type AssistantTeamId,
  type ProjectId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { openCommandPalette } from "~/commandPaletteBus";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { getRouter } from "~/router";
import { assistantDialogAtom } from "./assistantDialogState";
import {
  fakeAssistantEdits,
  fakeAssistants,
  fakeSandbox,
  fakeTeamEdits,
  publishSandbox,
  fakeSettings,
  resetFakeTelegram,
  fakeWatches,
  setFakeAutonomy,
  fakeScheduledTasks,
  publishAssistants,
  publishScheduledTasks,
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

installFakeEnvironment([threadWithHistory("thread-a", 2)], {
  assistants: true,
  telegramChannel: true,
  reasoningEffort: true,
});
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
  ...overrides,
});

// Saves and navigation settle through the real app, which is slow on a busy machine.
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });
// Settings shows beside the sidebar, whose assistant rows and buttons carry the same names.
const settingsContent = () => page.getByRole("region", { name: "Settings content" });

async function openApp(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  return Object.assign(await render(<AppRoot router={router} />, { container, router: false }), {
    router,
  });
}

const scheduledTask = (id: string, title: string, threadId: string | null): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title,
  prompt: "Check in",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: "project-1" as ProjectId,
  threadId: threadId as ThreadId | null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex" as never, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-03-17T19:00:00.000Z",
  updatedAt: "2026-03-17T19:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});

// The dialog keeps everything but the basics behind "Advanced".
const openAdvanced = () => userEvent.click(page.getByRole("button", { name: "Advanced" }));

async function openEditDialog(name: string) {
  // The dialog target is app-wide state that outlives a disposed screen.
  appAtomRegistry.set(assistantDialogAtom, null);
  const screen = await openApp("/settings/assistants");
  await userEvent.click(page.getByRole("button", { name: `Edit ${name}` }));
  await openAdvanced();
  return screen;
}

it("lists assistants in Settings with an Archived section", async () => {
  fakeAssistants.items = [
    assistant("jarvis", "Jarvis", { isDefault: true }),
    assistant("old", "Retired", { archivedAt: "2026-03-18T00:00:00.000Z" }),
  ];
  await using _screen = await openApp("/settings/assistants");
  await expect
    .element(settingsContent().getByRole("button", { name: "New assistant" }))
    .toBeVisible();
  await expect.element(page.getByText("Archived", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Unarchive" })).toBeVisible();
});

it("lists groups in Settings with a way into their chat, and archived groups with Restore", async () => {
  const when = "2026-03-17T19:00:00.000Z";
  const group = (id: string, name: string, archivedAt: string | null) => ({
    id: id as AssistantTeamId,
    name,
    memberIds: ["jarvis"] as AssistantId[],
    leadId: null,
    archivedAt,
    createdAt: when,
    updatedAt: when,
  });
  fakeTeamEdits.updates = [];
  publishAssistants(
    [assistant("jarvis", "Jarvis", { isDefault: true })],
    [group("t1", "Leaders", null), group("t2", "Old crew", "2026-03-18T00:00:00.000Z")],
  );
  await using screen = await openApp("/settings/assistants");
  await userEvent.click(settingsContent().getByRole("button", { name: "Open Leaders chat" }));
  await eventually(() => expect(screen.router.state.location.pathname).toContain("/group/"));
  await screen.router.navigate({ to: "/settings/assistants" });
  await userEvent.click(settingsContent().getByRole("button", { name: "Restore" }));
  await eventually(() =>
    expect(fakeTeamEdits.updates).toMatchObject([{ teamId: "t2", archived: false }]),
  );
});

it("Jarvis can be deleted like any assistant, and Restore Jarvis asks the server for him", async () => {
  fakeAssistantEdits.creates = [];
  fakeAssistantEdits.created = assistant("jarvis", "Jarvis", { isDefault: true });
  publishAssistants([fakeAssistantEdits.created]);
  await using _screen = await openApp("/settings/assistants");
  expect(page.getByRole("button", { name: "Restore Jarvis" }).query()).toBeNull();
  await userEvent.click(settingsContent().getByRole("button", { name: "Jarvis actions" }));
  await expect.element(page.getByRole("menuitem", { name: "Archive assistant" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Delete assistant" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  publishAssistants([]);
  await userEvent.click(page.getByRole("button", { name: "Restore Jarvis" }));
  await eventually(() =>
    expect(fakeAssistantEdits.creates).toMatchObject([{ restoreDefault: true }]),
  );
});

it("saves the spending limit the user sets and shows what was spent", async () => {
  publishAssistants([
    assistant("jarvis", "Jarvis", {
      budget: {
        amountUsd: 5,
        period: "monthly",
        warnAtPercent: 80,
        blockWhenExceeded: true,
        timeZone: "UTC",
      },
    }),
  ]);
  fakeAssistantEdits.updates = [];
  fakeAssistantEdits.spend = {
    todayUsd: 0.5,
    periodUsd: 1.25,
    partial: false,
    budget: {
      period: "monthly",
      amountUsd: 5,
      spentUsd: 1.25,
      warnAtPercent: 80,
      resetsAt: "2026-04-01T00:00:00.000Z",
      timeZone: "UTC",
      state: "ok",
      blocking: false,
    },
  };
  await using _screen = await openEditDialog("Jarvis");
  await expect.element(page.getByText("$1.25 this month", { exact: false })).toBeVisible();
  await userEvent.fill(page.getByLabelText("Amount (USD)"), "$12.50");
  await userEvent.fill(page.getByLabelText("Warn at (%)"), "90");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      {
        assistantId: "jarvis",
        budget: { amountUsd: 12.5, period: "monthly", warnAtPercent: 90, blockWhenExceeded: true },
      },
    ]),
  );
});

it("saves the effort the user picks with the assistant's model", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.updates = [];
  await using _screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("button", { name: /Medium/ }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "High" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      {
        assistantId: "jarvis",
        modelSelection: { model: "gpt-5.4", options: [{ id: "reasoningEffort", value: "high" }] },
      },
    ]),
  );
});

it("saves the period and whether the limit stops new turns", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.updates = [];
  fakeAssistantEdits.spend = null;
  await using _screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("switch", { name: "Limit spending" }));
  await userEvent.fill(page.getByLabelText("Amount (USD)"), "3");
  await userEvent.click(page.getByRole("radio", { name: "Weekly (Mon–Sun)" }));
  await userEvent.click(page.getByRole("switch", { name: "Stop when reached" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      { budget: { amountUsd: 3, period: "weekly", blockWhenExceeded: false } },
    ]),
  );
});

it("refuses an invalid spending limit without saving", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.updates = [];
  fakeAssistantEdits.spend = null;
  await using _screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("switch", { name: "Limit spending" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await expect.element(page.getByText("Enter a spending limit of at least $0.01.")).toBeVisible();
  await userEvent.fill(page.getByLabelText("Amount (USD)"), "5");
  await userEvent.fill(page.getByLabelText("Warn at (%)"), "150");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await expect
    .element(page.getByText("Warn at must be a whole percent from 1 to 100."))
    .toBeVisible();
  expect(fakeAssistantEdits.updates).toEqual([]);
});

it("removes the cap when the limit is switched off", async () => {
  publishAssistants([
    assistant("jarvis", "Jarvis", {
      budget: {
        amountUsd: 5,
        period: "monthly",
        warnAtPercent: 80,
        blockWhenExceeded: true,
        timeZone: "UTC",
      },
    }),
  ]);
  fakeAssistantEdits.updates = [];
  fakeAssistantEdits.spend = null;
  await using _screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("switch", { name: "Limit spending" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([{ assistantId: "jarvis", budget: null }]),
  );
});

it("lists only the schedules bound to the assistant's conversation and manages them", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  publishScheduledTasks([
    scheduledTask("daily", "Morning brief", "assistant:jarvis:1"),
    scheduledTask("other", "Someone else's job", "assistant:other:1"),
    scheduledTask("loose", "Unbound job", null),
  ]);
  fakeScheduledTasks.toggles = [];
  fakeScheduledTasks.failToggle = null;
  await using _screen = await openEditDialog("Jarvis");
  await expect.element(page.getByText("Morning brief")).toBeVisible();
  expect(page.getByText("Someone else's job").query()).toBeNull();
  expect(page.getByText("Unbound job").query()).toBeNull();

  await userEvent.click(page.getByRole("switch", { name: "Pause Morning brief" }));
  await eventually(() =>
    expect(fakeScheduledTasks.toggles).toEqual([{ id: "daily", enabled: false }]),
  );

  fakeScheduledTasks.failToggle = "Server said no";
  await userEvent.click(page.getByRole("switch", { name: "Pause Morning brief" }));
  await expect.element(page.getByText("Could not update schedule")).toBeVisible();
  await expect.element(page.getByText("Server said no")).toBeVisible();
});

it("opens a schedule from the assistant's list", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  publishScheduledTasks([scheduledTask("daily", "Morning brief", "assistant:jarvis:1")]);
  await using screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("button", { name: "Edit Morning brief" }));
  await eventually(() => {
    expect(screen.router.state.location.pathname).toBe("/settings/scheduled-tasks");
    expect(screen.router.state.location.search).toMatchObject({ taskId: "daily" });
  });
  expect(page.getByRole("dialog", { name: "Jarvis settings" }).query()).toBeNull();
});

it("starts a new schedule bound to the assistant's conversation", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  publishScheduledTasks([]);
  await using screen = await openEditDialog("Jarvis");
  await expect
    .element(page.getByText("Nothing scheduled. Add a schedule to have it check in on its own."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "New schedule" }));
  await eventually(() =>
    expect(screen.router.state.location.search).toMatchObject({
      threadId: "assistant:jarvis:1",
    }),
  );
});

const watch = (id: string, overrides: Partial<AutonomyWatch> = {}): AutonomyWatch => ({
  id: id as AutonomyWatch["id"],
  assistantId: "jarvis",
  title: "CI on PR 42",
  filter: { event: "pr_checks_failed", prNumber: 42 },
  instruction: "Find out why",
  oneShot: false,
  expiresAt: null,
  enabled: true,
  triggerCount: 0,
  lastTriggeredAt: null,
  createdAt: "2026-03-17T19:00:00.000Z",
  ...overrides,
});

it("writes the whole autonomy object when a switch changes", async () => {
  fakeSettings.patches = [];
  fakeAssistants.items = [assistant("jarvis", "Jarvis", { isDefault: true })];
  const on = { ...DEFAULT_AUTONOMY_SETTINGS, enabled: true };
  setFakeAutonomy(on);
  appAtomRegistry.reset();
  await using _screen = await openApp("/settings/assistants");
  await userEvent.click(page.getByRole("switch", { name: "Assistants can notify you" }));
  await userEvent.click(page.getByRole("switch", { name: "Run looks stuck" }));
  await userEvent.click(page.getByRole("switch", { name: "Notify on Telegram" }));
  await eventually(() => expect(fakeSettings.patches).toHaveLength(3));
  // Each patch carries every field, so a write never drops a sibling setting.
  expect(fakeSettings.patches).toEqual([
    { autonomy: { ...on, enabled: false } },
    { autonomy: { ...on, rules: { ...on.rules, stuck: false } } },
    { autonomy: { ...on, channels: ["t3"] } },
  ]);
});

it("locks the rules, limits and channels while notifications are paused", async () => {
  fakeAssistants.items = [assistant("jarvis", "Jarvis", { isDefault: true })];
  setFakeAutonomy(DEFAULT_AUTONOMY_SETTINGS);
  appAtomRegistry.reset();
  await using _screen = await openApp("/settings/assistants");
  await expect
    .element(page.getByRole("switch", { name: "Assistants can notify you" }))
    .toBeEnabled();
  for (const name of ["Run looks stuck", "Notify on Telegram"]) {
    await expect.element(page.getByRole("switch", { name })).toBeDisabled();
  }
  await expect.element(page.getByLabelText("Waiting minutes")).toBeDisabled();
});

it("saves valid numbers once and refuses out-of-range ones", async () => {
  fakeSettings.patches = [];
  fakeAssistants.items = [assistant("jarvis", "Jarvis", { isDefault: true })];
  const on = { ...DEFAULT_AUTONOMY_SETTINGS, enabled: true };
  setFakeAutonomy(on);
  appAtomRegistry.reset();
  await using _screen = await openApp("/settings/assistants");
  await userEvent.fill(page.getByLabelText("Waiting minutes"), "45");
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(page.getByLabelText("Notifications per day"), "5000");
  await expect.element(page.getByText("Enter a whole number from 1 to 1000.")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(page.getByLabelText("Stuck minutes"), "10");
  await userEvent.keyboard("{Enter}");
  await eventually(() => expect(fakeSettings.patches).toHaveLength(2));
  expect(fakeSettings.patches).toEqual([
    { autonomy: { ...on, waitingMinutes: 45 } },
    { autonomy: { ...on, stuckMinutes: 10 } },
  ]);
});

it("links to Telegram settings until a bot is connected", async () => {
  fakeAssistants.items = [assistant("jarvis", "Jarvis", { isDefault: true })];
  resetFakeTelegram();
  await using screen = await openApp("/settings/assistants");
  await expect.element(page.getByText("Telegram is not set up")).toBeVisible();
  await userEvent.click(page.getByRole("link", { name: "Open Telegram settings" }));
  await eventually(() => expect(screen.router.state.location.pathname).toBe("/settings/telegram"));
});

it("shows no Telegram notice once a bot is connected", async () => {
  fakeAssistants.items = [assistant("jarvis", "Jarvis", { isDefault: true })];
  resetFakeTelegram({ enabled: true, tokenConfigured: true });
  // The first test's Telegram settings are still cached.
  appAtomRegistry.reset();
  await using _screen = await openApp("/settings/assistants");
  await expect.element(page.getByRole("switch", { name: "Notify on Telegram" })).toBeVisible();
  expect(page.getByText("Telegram is not set up").query()).toBeNull();
});

it("saves the assistant's notification choices, inherited or custom", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.updates = [];
  await using _screen = await openEditDialog("Jarvis");
  expect(page.getByText("When to notify").query()).toBeNull();
  await userEvent.click(page.getByRole("radio", { name: "Reply and notify me" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      { autonomy: { mode: "reply-and-notify", rules: null, projectIds: null, channels: null } },
    ]),
  );

  fakeAssistantEdits.updates = [];
  await userEvent.click(page.getByRole("button", { name: "Edit Jarvis" }));
  await openAdvanced();
  await userEvent.click(page.getByRole("radio", { name: "Reply and notify me" }));
  await userEvent.click(page.getByRole("radio", { name: "Only for these" }));
  await userEvent.click(page.getByRole("checkbox", { name: "Run looks stuck" }));
  await userEvent.click(page.getByRole("radio", { name: "Only these projects" }));
  await userEvent.click(page.getByRole("radio", { name: "Only on these" }));
  await userEvent.click(page.getByRole("checkbox", { name: "Telegram" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      {
        autonomy: {
          mode: "reply-and-notify",
          rules: ["runFailed", "waitingTooLong", "ciFailed", "reviewIncomplete"],
          projectIds: ["project-1"],
          channels: ["t3"],
        },
      },
    ]),
  );
});

it("saves Ask before acting only when it changed", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.updates = [];
  await using _screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("switch", { name: "Ask before acting" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([{ askBeforeActing: true }]),
  );
});

it("saves the workspace the user picks", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.updates = [];
  publishSandbox({ ...fakeSandbox.status, state: "running" });
  await using _screen = await openEditDialog("Jarvis");
  await expect.element(page.getByRole("radio", { name: /^This Mac/ })).toBeChecked();
  await userEvent.click(page.getByRole("radio", { name: /Sandbox container/ }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      { assistantId: "jarvis", workspace: "sandbox" },
    ]),
  );
});

it("creates an assistant that works in the sandbox", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.creates = [];
  publishSandbox({ ...fakeSandbox.status, state: "running" });
  appAtomRegistry.set(assistantDialogAtom, null);
  await using _screen = await openApp("/settings/assistants");
  await userEvent.click(settingsContent().getByRole("button", { name: "New assistant" }));
  await userEvent.fill(page.getByLabelText("Name"), "Boxed");
  await openAdvanced();
  await userEvent.click(page.getByRole("radio", { name: /Sandbox container/ }));
  await userEvent.click(page.getByRole("button", { name: "Create assistant" }));
  await eventually(() =>
    expect(fakeAssistantEdits.creates).toMatchObject([{ name: "Boxed", workspace: "sandbox" }]),
  );
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("turns the sandbox choice off with the reason when Docker is not available", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  publishSandbox({ ...fakeSandbox.status, state: "docker_unavailable" });
  await using _screen = await openEditDialog("Jarvis");
  await expect.element(page.getByRole("radio", { name: /Sandbox container/ })).toBeDisabled();
  await expect.element(page.getByText("Docker is not running on that machine.")).toBeVisible();
});

it("shows the sandbox state in Settings and starts it", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeSandbox.calls = [];
  publishSandbox({ ...fakeSandbox.status, state: "not_created", environmentId: null });
  appAtomRegistry.set(assistantDialogAtom, null);
  await using _screen = await openApp("/settings/assistants");
  await expect.element(page.getByText("Not created")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Remove" })).toBeDisabled();
  expect(page.getByRole("button", { name: "Sign in" }).query()).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Start" }));
  await eventually(() =>
    expect(fakeSandbox.calls).toMatchObject([{ tag: "assistantSandbox.start" }]),
  );
});

it("stops a running sandbox, offers the provider sign-in, and removes it keeping or deleting its files", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeSandbox.calls = [];
  publishSandbox({
    ...fakeSandbox.status,
    state: "running",
    environmentId: "environment-box" as never,
    url: "http://127.0.0.1:49152",
    linkedEnvironmentsEnabled: true,
  });
  appAtomRegistry.set(assistantDialogAtom, null);
  await using _screen = await openApp("/settings/assistants");
  await expect.element(page.getByText("Running")).toBeVisible();
  await expect.element(page.getByText("Sign in to providers in the sandbox")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Stop" }));
  await eventually(() =>
    expect(fakeSandbox.calls).toMatchObject([{ tag: "assistantSandbox.stop" }]),
  );
  const confirmStep = async () => {
    await userEvent.click(page.getByRole("button", { name: "Confirm" }));
  };
  const cancelStep = async () => {
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  };
  await userEvent.click(page.getByRole("button", { name: "Remove" }));
  await confirmStep();
  await expect.element(page.getByText("Also delete its files?")).toBeVisible();
  await cancelStep();
  await eventually(() =>
    expect(fakeSandbox.calls.at(-1)).toMatchObject({
      tag: "assistantSandbox.remove",
      input: { deleteVolumes: false },
    }),
  );
  await userEvent.click(page.getByRole("button", { name: "Remove" }));
  await confirmStep();
  await expect.element(page.getByText("Also delete its files?")).toBeVisible();
  await confirmStep();
  await eventually(() =>
    expect(fakeSandbox.calls.at(-1)).toMatchObject({ input: { deleteVolumes: true } }),
  );
});

it("shows the sandbox CPU limit and what happens when a task is done, and saves a change", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeSandbox.calls = [];
  publishSandbox({ ...fakeSandbox.status, state: "stopped", cpus: 3, whenDone: "discard" });
  appAtomRegistry.set(assistantDialogAtom, null);
  await using _screen = await openApp("/settings/assistants");
  const cpu = page.getByRole("combobox", { name: "CPU limit" });
  await expect.element(cpu).toHaveTextContent("3 cores");
  await userEvent.click(cpu);
  await userEvent.click(page.getByRole("option", { name: "No limit" }));
  await eventually(() =>
    expect(fakeSandbox.calls.at(-1)).toMatchObject({
      tag: "assistantSandbox.configure",
      input: { cpus: null },
    }),
  );
  const whenDone = page.getByRole("combobox", { name: "When a task is done" });
  await expect.element(whenDone).toHaveTextContent("Discard the container");
  await userEvent.click(whenDone);
  await userEvent.click(page.getByRole("option", { name: "Keep the container" }));
  await eventually(() =>
    expect(fakeSandbox.calls.at(-1)).toMatchObject({ input: { whenDone: "keep" } }),
  );
});

it("signing in to the sandbox's providers asks the server for a one-time pairing link", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeSandbox.calls = [];
  publishSandbox({
    ...fakeSandbox.status,
    state: "running",
    environmentId: "environment-box" as never,
    url: "http://127.0.0.1:1",
    linkedEnvironmentsEnabled: true,
  });
  appAtomRegistry.set(assistantDialogAtom, null);
  await using _screen = await openApp("/settings/assistants");
  await userEvent.click(page.getByRole("button", { name: "Sign in" }));
  await eventually(() =>
    expect(fakeSandbox.calls).toMatchObject([{ tag: "assistantSandbox.pairing" }]),
  );
});

it("adds a connector with a header, then saves it without echoing secrets", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.updates = [];
  await using _screen = await openEditDialog("Jarvis");
  await expect
    .element(page.getByText("Connectors work with Claude", { exact: false }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Add connector" }));
  await userEvent.fill(page.getByLabelText("Connector name"), "docs");
  await userEvent.fill(page.getByLabelText("URL"), "nope");
  await userEvent.click(page.getByRole("button", { name: "Add header" }));
  await userEvent.fill(page.getByLabelText("Header 1", { exact: true }), "Authorization");
  await userEvent.fill(page.getByLabelText("Header 1 value"), "Bearer abc");
  await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
  await expect.element(page.getByText('"docs" needs an http or https URL.')).toBeVisible();
  await userEvent.fill(page.getByLabelText("URL"), "https://docs.example.test/mcp");
  await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
  await expect.element(page.getByText("docs", { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      {
        mcpServers: [
          {
            name: "docs",
            transport: "http",
            url: "https://docs.example.test/mcp",
            headers: [{ key: "Authorization", value: "Bearer abc" }],
            enabled: true,
          },
        ],
      },
    ]),
  );
});

it("edits a saved connector keeping its secret, toggles it and removes another", async () => {
  publishAssistants([
    assistant("jarvis", "Jarvis", {
      mcpServers: [
        {
          name: "docs",
          transport: "http",
          url: "https://docs.example.test/mcp",
          args: [],
          headers: [{ key: "Authorization", hasValue: true }],
          env: [],
          enabled: true,
        },
        {
          name: "files",
          transport: "stdio",
          command: "npx",
          args: ["srv"],
          headers: [],
          env: [],
          enabled: true,
        },
      ],
    }),
  ]);
  fakeAssistantEdits.updates = [];
  await using _screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("button", { name: "Remove files" }));
  await userEvent.click(page.getByRole("switch", { name: "docs enabled" }));
  await userEvent.click(page.getByRole("button", { name: "Edit docs" }));
  await expect
    .element(page.getByLabelText("Header 1 value"))
    .toHaveAttribute("placeholder", "Saved");
  await userEvent.fill(page.getByLabelText("URL"), "https://docs.example.test/v2");
  await userEvent.click(page.getByRole("button", { name: "Done" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      {
        mcpServers: [
          {
            name: "docs",
            url: "https://docs.example.test/v2",
            headers: [{ key: "Authorization" }],
            enabled: false,
          },
        ],
      },
    ]),
  );
  expect(JSON.stringify(fakeAssistantEdits.updates)).not.toContain('"value"');
});

it("a command connector takes arguments and variables", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.updates = [];
  await using _screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("button", { name: "Add connector" }));
  await userEvent.fill(page.getByLabelText("Connector name"), "files");
  await userEvent.click(page.getByRole("radio", { name: "Command (runs on this machine)" }));
  await userEvent.fill(page.getByLabelText("Command", { exact: true }), "npx");
  await userEvent.fill(page.getByLabelText("Arguments"), "-y\nsrv");
  await userEvent.click(page.getByRole("button", { name: "Add variable" }));
  await userEvent.fill(page.getByLabelText("Variable 1", { exact: true }), "TOKEN");
  await userEvent.fill(page.getByLabelText("Variable 1 value"), "t");
  await userEvent.click(page.getByRole("button", { name: "Remove variable 1" }));
  await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      {
        mcpServers: [
          { name: "files", transport: "stdio", command: "npx", args: ["-y", "srv"], env: [] },
        ],
      },
    ]),
  );
});

it("keeps an unchanged assistant's autonomy out of the update", async () => {
  publishAssistants([
    assistant("jarvis", "Jarvis", {
      autonomy: { mode: "reply-and-notify", rules: [], projectIds: null, channels: null },
    }),
  ]);
  fakeAssistantEdits.updates = [];
  await using _screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("radio", { name: "Same as global" }).first());
  await userEvent.click(page.getByRole("radio", { name: "Only reply when I message it" }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() =>
    expect(fakeAssistantEdits.updates).toMatchObject([
      { autonomy: { mode: "reply-only", rules: null } },
    ]),
  );
});

it("shows each assistant's role in the list", async () => {
  publishAssistants([
    assistant("jarvis", "Jarvis", { role: "CEO" }),
    assistant("eng", "Engineer", { role: "Builder" }),
  ]);
  await using _screen = await openApp("/settings/assistants");
  await eventually(() => {
    expect(document.body.innerText).toContain("@eng · Builder");
    expect(document.body.innerText).toContain("@jarvis · CEO ·");
  });
});

it("saves a trimmed role", async () => {
  publishAssistants([assistant("jarvis", "Jarvis"), assistant("eng", "Engineer")]);
  fakeAssistantEdits.updates = [];
  await using _edit = await openEditDialog("Engineer");
  await userEvent.fill(page.getByLabelText("Role"), "  Tech lead ");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await eventually(() => expect(fakeAssistantEdits.updates).toMatchObject([{ role: "Tech lead" }]));
});

it("creates an assistant with its notification choice", async () => {
  fakeAssistantEdits.creates = [];
  publishAssistants([assistant("jarvis", "Jarvis")]);
  appAtomRegistry.set(assistantDialogAtom, null);
  await using _screen = await openApp("/settings/assistants");
  await userEvent.click(settingsContent().getByRole("button", { name: "New assistant" }));
  await userEvent.fill(page.getByLabelText("Name"), "Scout");
  await userEvent.fill(page.getByLabelText("Role"), "Researcher");
  await openAdvanced();
  await userEvent.click(page.getByRole("radio", { name: "Reply and notify me" }));
  await userEvent.click(page.getByRole("button", { name: "Create assistant" }));
  await eventually(() =>
    expect(fakeAssistantEdits.creates).toMatchObject([
      {
        name: "Scout",
        role: "Researcher",
        askBeforeActing: true,
        autonomy: { mode: "reply-and-notify" },
      },
    ]),
  );
  appAtomRegistry.set(assistantDialogAtom, null);
});

it("creates, edits, pauses and deletes a watch", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeWatches.items = [watch("other", { assistantId: "someone", title: "Not mine" })];
  fakeWatches.calls = [];
  await using _screen = await openEditDialog("Jarvis");
  await expect.element(page.getByText("No watches yet.", { exact: false })).toBeVisible();
  expect(page.getByText("Not mine").query()).toBeNull();

  await userEvent.click(page.getByRole("button", { name: "New watch" }));
  await userEvent.click(page.getByRole("button", { name: "Save watch" }));
  await expect.element(page.getByText("Give the watch a title.")).toBeVisible();
  await userEvent.fill(page.getByLabelText("Title"), "CI on PR 42");
  await userEvent.fill(page.getByLabelText("PR number"), "42");
  await userEvent.fill(page.getByLabelText("What it should do"), "Find out why");
  await userEvent.click(page.getByRole("checkbox", { name: "Only once" }));
  await userEvent.click(page.getByRole("button", { name: "Save watch" }));
  await eventually(() =>
    expect(fakeWatches.calls).toMatchObject([
      {
        tag: "upsert",
        input: {
          assistantId: "jarvis",
          title: "CI on PR 42",
          filter: { event: "pr_checks_failed", prNumber: 42 },
          instruction: "Find out why",
          oneShot: true,
          expiresAt: null,
        },
      },
    ]),
  );
  await expect.element(page.getByText("PR checks fail · PR #42", { exact: false })).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Edit CI on PR 42" }));
  await userEvent.click(page.getByRole("combobox", { name: "Wake it when" }));
  await userEvent.click(page.getByRole("option", { name: "A run fails" }));
  expect(page.getByLabelText("PR number").query()).toBeNull();
  await userEvent.fill(page.getByLabelText("Expires"), "2030-01-02T10:30");
  await userEvent.click(page.getByRole("button", { name: "Save watch" }));
  await eventually(() =>
    expect(fakeWatches.calls.at(-1)).toMatchObject({
      tag: "upsert",
      input: { id: "new-watch", filter: { event: "run_failed" } },
    }),
  );
  expect((fakeWatches.calls.at(-1)!.input as { expiresAt: string }).expiresAt).toMatch(/^2030-/);

  await userEvent.click(page.getByRole("switch", { name: "Pause CI on PR 42" }));
  await eventually(() =>
    expect(fakeWatches.calls.at(-1)).toEqual({
      tag: "setEnabled",
      input: { id: "new-watch", enabled: false },
    }),
  );

  await userEvent.click(page.getByRole("button", { name: "Delete CI on PR 42" }));
  await userEvent.click(page.getByRole("button", { name: "Confirm" }));
  await eventually(() => expect(fakeWatches.calls.at(-1)?.tag).toBe("delete"));
  await expect.element(page.getByText("No watches yet.", { exact: false })).toBeVisible();
});

it.each([
  [true, "Pause assistant notifications"],
  [false, "Turn on assistant notifications"],
])("toggles assistant notifications from the palette (enabled: %s)", async (enabled, title) => {
  setFakeAutonomy({ ...DEFAULT_AUTONOMY_SETTINGS, enabled });
  appAtomRegistry.reset();
  fakeSettings.patches = [];
  publishAssistants([assistant("jarvis", "Jarvis", { isDefault: true })]);
  await using _screen = await openApp("/settings/assistants");
  openCommandPalette({ query: "notifications" });
  await page.getByRole("option", { name: title }).click();
  await eventually(() =>
    expect(fakeSettings.patches).toEqual([
      { autonomy: { ...DEFAULT_AUTONOMY_SETTINGS, enabled: !enabled } },
    ]),
  );
});
