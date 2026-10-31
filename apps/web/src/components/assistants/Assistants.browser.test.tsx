import { createMemoryHistory } from "@tanstack/react-router";
import {
  ScheduledTaskId,
  type Assistant,
  type AssistantId,
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
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { getRouter } from "~/router";
import { assistantDialogAtom } from "./assistantDialogState";
import {
  fakeAssistantEdits,
  fakeAssistants,
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

// Saves and navigation settle through the real app, which is slow on a busy machine.
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

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

async function openEditDialog(name: string) {
  // The dialog target is app-wide state that outlives a disposed screen.
  appAtomRegistry.set(assistantDialogAtom, null);
  const screen = await openApp("/settings/assistants");
  await userEvent.click(page.getByRole("button", { name: `Edit ${name}` }));
  return screen;
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

it("saves the period and whether the limit stops new turns", async () => {
  publishAssistants([assistant("jarvis", "Jarvis")]);
  fakeAssistantEdits.updates = [];
  fakeAssistantEdits.spend = null;
  await using _screen = await openEditDialog("Jarvis");
  await userEvent.click(page.getByRole("switch", { name: "Spending limit" }));
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
  await userEvent.click(page.getByRole("switch", { name: "Spending limit" }));
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
  await userEvent.click(page.getByRole("switch", { name: "Spending limit" }));
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
