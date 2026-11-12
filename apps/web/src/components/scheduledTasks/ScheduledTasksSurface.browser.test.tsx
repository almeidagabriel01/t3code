// @effect-diagnostics globalDate:off - Builds local wall-clock fixtures for the agenda.
import {
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  allowed: true,
  tasks: [] as ScheduledTask[] | null,
  error: null as string | null,
  toggle: vi.fn(),
  run: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  now: 0,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => state.allowed,
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => state.allowed) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => state.navigate,
}));
vi.mock(import("../../hooks/useNowMinute"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNowMinuteMs: () => state.now,
  useNowMinute: () => new Date(state.now).toISOString().slice(0, 16),
}));
vi.mock(import("../ui/toast"), async (importOriginal) => ({
  ...(await importOriginal()),
  toastManager: { add: state.toast } as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => {
  const { serverEnvironment } = await import("../../state/server");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.setScheduledTaskEnabled ? state.toggle : state.run) as never,
  };
});
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: state.tasks === null ? null : { tasks: state.tasks },
    error: state.error,
  })) as never,
}));

import "~/index.css";
import { render } from "../../../test/render";
import { ScheduledTasksSurface } from "./ScheduledTasksSurface";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
const iso = (time: number) => new Date(time).toISOString();

const task = (title: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask =>
  ({
    id: ScheduledTaskId.make(title),
    title,
    projectId,
    threadId: null,
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "18:00" },
    nextRunAt: iso(at(12, 18)),
    lastRunAt: null,
    lastRunStatus: "never",
    runCount: 0,
    ...overrides,
  }) as ScheduledTask;

function setup(tasks: ScheduledTask[] | null, error: string | null = null) {
  state.allowed = true;
  state.tasks = tasks;
  state.error = error;
  state.now = at(12, 9);
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
  state.navigate.mockReset();
  state.toast.mockReset();
}

const surface = () => <ScheduledTasksSurface environmentId={environmentId} projectId={projectId} />;

it("places upcoming runs on today and tomorrow and lists the project's tasks in run order", async () => {
  setup([
    task("Nightly build"),
    task("Morning digest", {
      schedule: { type: "once", runAt: iso(at(12, 10)) },
      nextRunAt: iso(at(12, 10)),
    }),
    task("Paused sync", { enabled: false }),
    task("Other project", { projectId: ProjectId.make("other") }),
    task("Checked", { enabled: false, lastRunAt: iso(at(12, 7)), lastRunStatus: "failed" }),
  ]);
  await using _screen = await render(surface());

  const today = page.getByRole("region", { name: "Today" });
  const tomorrow = page.getByRole("region", { name: "Tomorrow" });
  await expect.element(today.getByRole("button", { name: /Morning digest/ })).toBeVisible();
  await expect.element(today.getByRole("button", { name: /Nightly build/ })).toBeVisible();
  await expect.element(today.getByRole("button", { name: /Checked.*failed/ })).toBeVisible();
  await expect.element(tomorrow.getByRole("button", { name: /Nightly build/ })).toBeVisible();
  await expect
    .element(tomorrow.getByRole("button", { name: /Morning digest/ }))
    .not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("Other project");

  const rows = [...document.querySelectorAll("ul > li")].map(
    (row) => row.querySelector("button span span:last-child")?.textContent,
  );
  expect(rows).toEqual(["Morning digest", "Nightly build", "Checked", "Paused sync"]);

  await today.getByRole("button", { name: /Morning digest/ }).click();
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/settings/scheduled-tasks",
    search: { environmentId, taskId: "Morning digest" },
  });
});

it("runs, pauses and resumes a task, and reports a failure", async () => {
  setup([task("Nightly build"), task("Paused sync", { enabled: false })]);
  await using _screen = await render(surface());

  await page.getByRole("button", { name: "Run Nightly build now" }).click();
  expect(state.run).toHaveBeenCalledWith({ environmentId, input: { id: "Nightly build" } });

  await page.getByRole("button", { name: "Pause Nightly build" }).click();
  expect(state.toggle).toHaveBeenCalledWith({
    environmentId,
    input: { id: "Nightly build", enabled: false },
  });

  state.toggle.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("Offline")) });
  await page.getByRole("button", { name: "Resume Paused sync" }).click();
  expect(state.toggle).toHaveBeenLastCalledWith({
    environmentId,
    input: { id: "Paused sync", enabled: true },
  });
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not resume the task" }),
    ),
  );

  state.run.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("Busy")) });
  await page.getByRole("button", { name: "Run Nightly build now" }).click();
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not run the task" }),
    ),
  );
});

it("disables actions without permission and hides run now for webhook tasks", async () => {
  setup([
    task("Hook", { schedule: { type: "webhook" } as ScheduledTask["schedule"], nextRunAt: null }),
  ]);
  state.allowed = false;
  await using _screen = await render(surface());
  await expect.element(page.getByRole("button", { name: "Pause Hook" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Run Hook now" })).not.toBeInTheDocument();
});

it("opens a task, its thread, and the scheduled task settings", async () => {
  setup([task("Bound", { threadId: ThreadId.make("thread-1") })]);
  await using _screen = await render(surface());

  await page.getByRole("button", { name: "Actions for Bound" }).click();
  await page.getByRole("menuitem", { name: "Open thread" }).click();
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "thread-1" },
  });

  await page.getByRole("button", { name: "Actions for Bound" }).click();
  await page.getByRole("menuitem", { name: "Open task" }).click();
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/settings/scheduled-tasks",
    search: { environmentId, taskId: "Bound" },
  });

  await page.getByRole("button", { name: "Manage scheduled tasks" }).click();
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/settings/scheduled-tasks",
    search: { environmentId },
  });
});

it.each([
  ["loading", null, null, "Loading scheduled tasks…"],
  ["failed", [], "Server unreachable", "Could not load scheduled tasks"],
  ["empty", [], null, "No scheduled tasks in this project"],
] as const)("shows the %s state", async (_name, tasks, error, text) => {
  setup(tasks === null ? null : [...tasks], error);
  await using _screen = await render(surface());
  await expect.element(page.getByText(text)).toBeVisible();
});
