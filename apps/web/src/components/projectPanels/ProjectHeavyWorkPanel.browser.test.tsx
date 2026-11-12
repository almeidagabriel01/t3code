import type {
  EnvironmentId,
  HeavyCommand,
  HeavyCommandsState,
  HeavyQueueEntry,
  HeavyQueueState,
  ProjectId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const mocks = vi.hoisted(() => ({
  actions: { setPriority: vi.fn(), setPaused: vi.fn(), canChange: true },
  stop: { canStop: true, stop: vi.fn() },
  state: null as unknown as HeavyQueueState,
  commands: { commands: [], cpuCount: 8 } as HeavyCommandsState,
  commandsEnvironment: [] as Array<string | null>,
  navigate: vi.fn(),
}));

vi.mock("../../state/heavyQueue", () => ({
  useHeavyQueue: () => mocks.state,
  useHeavyCommands: (environmentId: string | null) => {
    mocks.commandsEnvironment.push(environmentId);
    return environmentId === null ? { commands: [], cpuCount: 1 } : mocks.commands;
  },
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "p1", environmentId: "env", workspaceRoot: "/work/app", title: "App" },
    { id: "p2", environmentId: "env", workspaceRoot: "/work/other", title: "Other" },
    { id: "p1", environmentId: "env-2", workspaceRoot: "/work/elsewhere", title: "Remote" },
  ],
  useThreadShells: () => [
    { environmentId: "env", id: "t1", projectId: "p1", title: "Fix build" },
    { environmentId: "env", id: "t2", projectId: "p2", title: "Other work" },
  ],
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../statusBar/useKillTarget", () => ({
  useHeavyQueueActions: () => mocks.actions,
  useStopHeavyCommand: () => mocks.stop,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));

import { ProjectHeavyWorkPanel } from "./ProjectHeavyWorkPanel";

const STARTED = "2026-01-01T00:00:00.000Z";
const entry = (id: string, over: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label: `pnpm ${id}`,
  cwd: "/work/app",
  createdAt: STARTED,
  startedAt: null,
  ...over,
});
const command = (name: string, over: Partial<HeavyCommand> = {}): HeavyCommand =>
  ({
    source: "agent",
    pid: name.length,
    startTimeMs: 1,
    threadId: null,
    label: name,
    name,
    startedAt: STARTED,
    stoppable: true,
    ...over,
  }) as HeavyCommand;

function setup(entries: HeavyQueueEntry[], commands: HeavyCommand[]) {
  mocks.actions.setPriority.mockReset();
  mocks.stop.stop.mockReset();
  mocks.navigate.mockReset();
  mocks.commandsEnvironment = [];
  mocks.commands = { commands, cpuCount: 8 };
  mocks.state = {
    entries,
    enabled: true,
    paused: false,
    rules: [],
    maxRunning: 2,
    reasons: {},
    room: true,
    claudeHookInstalled: false,
    deviceIdleMinutes: 20,
    machine: null,
  };
}

const panel = (visible = true) => (
  <ProjectHeavyWorkPanel
    environmentId={"env" as EnvironmentId}
    projectId={"p1" as ProjectId}
    visible={visible}
  />
);

it("shows only this project's commands and jobs, worktree jobs by their thread, at their queue places", async () => {
  setup(
    [
      entry("worktree", { cwd: "/home/.t3/worktrees/app-1", threadId: "t1", startedAt: STARTED }),
      entry("other", { cwd: "/work/other" }),
      entry("build", { cwd: "/work/app/src" }),
    ],
    [command("vitest", { threadId: "t1" }), command("gradle", { threadId: "t2" })],
  );
  await using screen = await render(panel());
  await expect.element(screen.getByText("vitest")).toBeVisible();
  expect(screen.getByText("gradle").elements()).toHaveLength(0);
  await expect.element(screen.getByText("pnpm worktree")).toBeVisible();
  await expect.element(screen.getByText("pnpm build")).toBeVisible();
  expect(screen.getByText("pnpm other").elements()).toHaveLength(0);
  await expect.element(screen.getByText(/^2nd/)).toBeVisible();
  await expect.element(screen.getByText(/^Whole queue: /)).toBeVisible();
  expect(
    screen.getByRole("switch", { name: "Pause the heavy work queue" }).elements(),
  ).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Stop vitest" }));
  expect(mocks.stop.stop).toHaveBeenCalledWith(expect.objectContaining({ name: "vitest" }));
});

it.each([
  { job: "waiting", over: {}, item: "High priority now", priority: "high" },
  {
    job: "running",
    over: { startedAt: STARTED, qos: "normal" },
    item: "Lower priority",
    priority: "low",
  },
  {
    job: "lowered",
    over: { startedAt: STARTED, qos: "background" },
    item: "Normal priority",
    priority: "high",
  },
] as const)("$item on a $job job changes its priority", async ({ over, item, priority }) => {
  setup([entry("run", over)], []);
  await using screen = await render(panel());
  await userEvent.click(screen.getByRole("button", { name: "Actions for pnpm run" }));
  await userEvent.click(screen.getByRole("menuitem", { name: item }));
  expect(mocks.actions.setPriority).toHaveBeenCalledWith("run", priority);
});

it("opens the thread behind a job and the heavy work settings", async () => {
  setup([entry("run", { startedAt: STARTED, threadId: "t1" })], []);
  await using screen = await render(panel());
  await userEvent.click(screen.getByRole("button", { name: "Fix build" }));
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "env", threadId: "t1" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Heavy work settings" }));
  expect(mocks.navigate).toHaveBeenLastCalledWith({
    to: "/settings/maintenance",
    hash: "heavy-work",
  });
});

it("stops the process sampling while hidden and says when the project has no heavy work", async () => {
  setup([entry("other", { cwd: "/work/other" })], [command("vitest", { threadId: "t1" })]);
  await using screen = await render(panel(false));
  await expect.element(screen.getByText("No heavy work in this project")).toBeVisible();
  expect(new Set(mocks.commandsEnvironment)).toEqual(new Set([null]));
});
