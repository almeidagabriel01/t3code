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
import { assistantWorkAtom } from "./assistantWorkState";
import {
  PROJECT_ID,
  fakeAssistantEdits,
  fakeCommands,
  fakeScheduledTasks,
  installFakeEnvironment,
  publishAssistants,
  publishScheduledTasks,
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

const conversation = threadWithHistory("assistant:jarvis:1", 1);
installFakeEnvironment(
  [
    {
      ...conversation,
      runs: conversation.runs.map((run) => ({ ...run, status: "failed" as const })),
    },
  ],
  { assistants: true },
);
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const assistant = (id: string, name: string, overrides: Partial<Assistant> = {}): Assistant => ({
  id: id as AssistantId,
  handle: id,
  name,
  projectId: PROJECT_ID,
  instructions: "",
  toolAccess: "workspace-write",
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

const routine = (id: string, title: string, overrides: Partial<ScheduledTask> = {}) =>
  ({
    id: ScheduledTaskId.make(id),
    title,
    prompt: "Report",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: PROJECT_ID as ProjectId,
    threadId: "assistant:jarvis:1" as ThreadId,
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
    ...overrides,
  }) as ScheduledTask;

const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });

async function openWork(assistants: Assistant[] = [assistant("jarvis", "Jarvis")]) {
  appAtomRegistry.set(assistantDialogAtom, null);
  appAtomRegistry.set(assistantWorkAtom, null);
  publishAssistants(assistants);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/assistants"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  await userEvent.click(
    page.getByRole("article", { name: assistants[0]!.name }).getByRole("button", { name: "Work" }),
  );
  return screen;
}

it("opens from the card, says it can work, and retries a failed run", async () => {
  fakeCommands.dispatched.length = 0;
  await using _screen = await openWork();
  const dialog = page.getByRole("dialog", { name: "Jarvis work" });
  await expect.element(dialog.getByText("Ready to work")).toBeVisible();
  await expect.element(dialog.getByText("Its last run failed.")).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Retry" }));
  await eventually(() =>
    expect(fakeCommands.dispatched).toContainEqual(
      expect.objectContaining({
        type: "message.dispatch",
        threadId: "assistant:jarvis:1",
        text: "That did not finish. Please try again.",
      }),
    ),
  );
});

it("says why it cannot work and sends the fix to where it is made", async () => {
  await using _screen = await openWork([
    assistant("jarvis", "Jarvis", { projectId: "project-gone" as ProjectId }),
  ]);
  const dialog = page.getByRole("dialog", { name: "Jarvis work" });
  await expect.element(dialog.getByText("Its project is missing")).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Choose a project" }));
  expect(appAtomRegistry.get(assistantDialogAtom)).toMatchObject({ assistantId: "jarvis" });
  expect(appAtomRegistry.get(assistantWorkAtom)).toBeNull();
});

it("lists routines with their next run, pauses and resumes them, and runs one now", async () => {
  publishScheduledTasks([
    routine("daily", "Daily report", { nextRunAt: "2099-03-04T09:30:00.000Z" }),
    routine("broken", "Weekly sweep", {
      lastRunStatus: "failed",
      lastRunError: "Provider said no",
    }),
    routine("other", "Someone else's", { threadId: "assistant:other:1" as ThreadId }),
  ]);
  fakeScheduledTasks.toggles = [];
  fakeScheduledTasks.runs = [];
  await using _screen = await openWork();
  const dialog = page.getByRole("dialog", { name: "Jarvis work" });
  await expect.element(dialog.getByText("Daily report")).toBeVisible();
  await expect.element(dialog.getByText(/next/)).toBeVisible();
  await expect.element(dialog.getByText("Last run failed: Provider said no")).toBeVisible();
  expect(page.getByText("Someone else's").query()).toBeNull();

  await userEvent.click(dialog.getByRole("switch", { name: "Pause Daily report" }));
  await eventually(() =>
    expect(fakeScheduledTasks.toggles).toEqual([{ id: "daily", enabled: false }]),
  );
  await userEvent.click(dialog.getByRole("button", { name: "Run Weekly sweep now" }));
  await eventually(() => expect(fakeScheduledTasks.runs).toEqual(["broken"]));
});

it("lists the files it sent and received", async () => {
  fakeAssistantEdits.library = {
    files: [
      {
        name: "report.pdf",
        path: "/shared/transfers/jarvis/m1/report.pdf",
        size: 2048,
        direction: "sent",
        from: null,
        savedAt: "2026-03-17T19:00:00.000Z",
      },
      {
        name: "notes.md",
        path: "/shared/transfers/ada/m2/notes.md",
        size: 12,
        direction: "received",
        from: "Ada",
        savedAt: "2026-03-17T18:00:00.000Z",
      },
    ],
    truncated: true,
  };
  await using _screen = await openWork();
  const dialog = page.getByRole("dialog", { name: "Jarvis work" });
  await userEvent.click(dialog.getByRole("button", { name: "Library" }));
  await expect.element(dialog.getByText("report.pdf")).toBeVisible();
  await expect.element(dialog.getByText(/Received from Ada/)).toBeVisible();
  await expect.element(dialog.getByText(/Sent · 2 KB/)).toBeVisible();
  await expect.element(dialog.getByText("Showing the newest files.")).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Open report.pdf" })).toBeVisible();
  fakeAssistantEdits.library = { files: [], truncated: false };
  appAtomRegistry.set(assistantWorkAtom, null);
});

it("says memory is not ready when the server has no memory space", async () => {
  await using _screen = await openWork();
  const dialog = page.getByRole("dialog", { name: "Jarvis work" });
  await userEvent.click(dialog.getByRole("button", { name: "Memory" }));
  await expect
    .element(dialog.getByText("Memory is off or still getting ready on this server."))
    .toBeVisible();
});
