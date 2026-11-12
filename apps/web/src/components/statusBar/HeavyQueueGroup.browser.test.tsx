import type {
  EnvironmentId,
  HeavyCommand,
  HeavyCommandsState,
  HeavyQueueEntry,
  HeavyQueueState,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const mocks = vi.hoisted(() => ({
  actions: {
    move: vi.fn(),
    startNow: vi.fn(),
    cancel: vi.fn(),
    setEnabled: vi.fn(),
    setPaused: vi.fn(),
    setRule: vi.fn(),
    setMaxRunning: vi.fn(),
    canChange: true,
  },
  state: null as unknown as HeavyQueueState,
  commands: { commands: [], cpuCount: 8 } as HeavyCommandsState,
  stop: { canStop: true, stop: vi.fn() },
  openThread: vi.fn(),
}));

vi.mock("../../state/heavyQueue", () => ({
  useHeavyQueue: () => mocks.state,
  useHeavyCommands: () => mocks.commands,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "p1", environmentId: "env", workspaceRoot: "/work/app", title: "App Project" },
    { id: "p2", environmentId: "env", workspaceRoot: "/work/app/pkg", title: "Package" },
  ],
  useThreadShells: () => [],
}));
vi.mock("../ProjectFavicon", () => ({
  ProjectFavicon: ({ project }: { project: { title: string } }) => (
    <i data-testid="favicon">{project.title}</i>
  ),
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "env",
}));
vi.mock("./useKillTarget", () => ({
  useCloseTerminal: () => ({ canClose: false, close: vi.fn() }),
  useShutDownDevice: () => ({ canShutDown: false, shutDown: vi.fn() }),
  useHeavyQueueActions: () => mocks.actions,
  useStopHeavyCommand: () => mocks.stop,
}));

import { HeavyCommandsGroup, HeavyQueueGroup, ResourceSegment } from "./ResourceSegment";

const environmentId = "env" as EnvironmentId;
const entry = (id: string, over: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label: `pnpm ${id}`,
  cwd: "/work/app/src",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  ...over,
});

function setup(entries: ReadonlyArray<HeavyQueueEntry>, over: Partial<HeavyQueueState> = {}) {
  for (const key of [
    "move",
    "startNow",
    "cancel",
    "setEnabled",
    "setPaused",
    "setRule",
    "setMaxRunning",
  ] as const) {
    mocks.actions[key].mockReset();
  }
  mocks.openThread.mockReset();
  mocks.actions.canChange = true;
  mocks.state = {
    entries,
    enabled: true,
    paused: false,
    rules: [],
    maxRunning: 3,
    reasons: {},
    room: true,
    claudeHookInstalled: false,
    deviceIdleMinutes: 20,
    machine: null,
    ...over,
  };
}

const title = (id: string) => (id === "t1" ? "Fix build" : undefined);
const group = () => (
  <HeavyQueueGroup
    environmentId={environmentId}
    threadTitle={title}
    onOpenThread={mocks.openThread}
  />
);
const openMenu = (screen: Awaited<ReturnType<typeof render>>, label: string) =>
  userEvent.click(screen.getByRole("button", { name: `Actions for pnpm ${label}` }));

describe("HeavyQueueGroup", () => {
  it("shows project, thread, reason, note and place for every entry", async () => {
    setup(
      [
        entry("test", {
          startedAt: "2026-01-01T00:00:00.000Z",
          threadId: "t1",
          name: "Server tests",
        }),
        entry("build", { note: "Moved by the user" }),
        entry("e2e"),
      ],
      { reasons: { build: "waiting for room: needs ~4.0 GB, 1.2 GB free" } },
    );
    await using screen = await render(group());
    await expect.element(screen.getByText("Fix build")).toBeVisible();
    await expect.element(screen.getByText("Server tests")).toBeVisible();
    await expect.element(screen.getByText("pnpm test")).toBeVisible();
    await expect.element(screen.getByText(/^Running · /)).toBeVisible();
    await expect.element(screen.getByText(/^1st/)).toBeVisible();
    await expect.element(screen.getByText(/^2nd/)).toBeVisible();
    await expect
      .element(screen.getByText(/waiting for room: needs ~4.0 GB, 1.2 GB free · Moved by the user/))
      .toBeVisible();
    await expect.element(screen.getByText("1 of 3 running")).toBeVisible();
    expect(screen.container.querySelectorAll('[data-testid="favicon"]')).toHaveLength(3);
  });

  it.each([
    { menu: "e2e", item: "Run next", expected: ["e2e", "build"] },
    { menu: "e2e", item: "Move up", expected: ["e2e", "build"] },
    { menu: "build", item: "Move down", expected: ["build", "lint"] },
    { menu: "build", item: "Move to end", expected: ["build", null] },
  ])("$item on $menu moves it", async ({ menu, item, expected }) => {
    setup([
      entry("run", { startedAt: "2026-01-01T00:00:00.000Z" }),
      entry("build"),
      entry("e2e"),
      entry("lint"),
    ]);
    await using screen = await render(group());
    await openMenu(screen, menu);
    await userEvent.click(screen.getByRole("menuitem", { name: item }));
    expect(mocks.actions.move).toHaveBeenCalledWith(...expected);
  });

  it("starts a waiter now from its own button, not for the running one", async () => {
    setup([entry("run", { startedAt: "2026-01-01T00:00:00.000Z" }), entry("b")]);
    await using screen = await render(group());
    expect(screen.container.querySelectorAll('[aria-label^="Start "]')).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Start pnpm b now" }));
    expect(mocks.actions.startNow).toHaveBeenCalledWith("b");
  });

  it("shows each job's usage on one muted line", async () => {
    setup(
      [
        entry("run", { startedAt: "2026-01-01T00:00:00.000Z", cpu: 2, memory: 3 * 1024 ** 3 }),
        entry("b"),
      ],
      {
        estimates: { b: { cpu: 4, memoryBytes: 3 * 1024 ** 3, durationMs: 120_000 } },
        machine: {
          busyCores: 2,
          cpuCount: 8,
          availableMemoryBytes: 8 * 1024 ** 3,
          totalMemoryBytes: 16 * 1024 ** 3,
        },
      },
    );
    await using screen = await render(group());
    await expect.element(screen.getByText("Using 2.0 cores (25%) · 3.0 GB")).toBeVisible();
    await expect.element(screen.getByText("Usually ~4.0 cores · 3.0 GB · 2 min")).toBeVisible();
  });

  it("greys out moves that would change nothing", async () => {
    setup([entry("a"), entry("b")]);
    await using screen = await render(group());
    await openMenu(screen, "a");
    await expect
      .element(screen.getByRole("menuitem", { name: "Run next" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect
      .element(screen.getByRole("menuitem", { name: "Move up" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  it("removes a waiter, stops the running one, and opens the thread", async () => {
    setup([entry("run", { startedAt: "2026-01-01T00:00:00.000Z", threadId: "t1" }), entry("b")]);
    await using screen = await render(group());
    await openMenu(screen, "b");
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from the queue" }));
    expect(mocks.actions.cancel).toHaveBeenCalledWith("b", false);
    await openMenu(screen, "run");
    await userEvent.click(screen.getByRole("menuitem", { name: "Stop" }));
    expect(mocks.actions.cancel).toHaveBeenCalledWith("run", true);
    await openMenu(screen, "run");
    await userEvent.click(screen.getByRole("menuitem", { name: "Open thread" }));
    expect(mocks.openThread).toHaveBeenCalledWith("t1");
    await userEvent.click(screen.getByRole("button", { name: "Fix build" }));
    expect(mocks.openThread).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Last", "last"],
    ["Normal", null],
  ] as const)("sets the project's priority to %s from the menu", async (name, priority) => {
    setup([entry("a"), entry("b")], { rules: [{ root: "/work/app", priority: "first" }] });
    await using screen = await render(group());
    await expect.element(screen.getByText("Always first").first()).toBeVisible();
    await openMenu(screen, "a");
    await userEvent.click(screen.getByRole("menuitemradio", { name }));
    expect(mocks.actions.setRule).toHaveBeenCalledWith("/work/app", priority);
  });

  it("pauses and resumes from the switch, and says so in the summary", async () => {
    setup([entry("a", { startedAt: "2026-01-01T00:00:00.000Z" })], { paused: true });
    await using screen = await render(group());
    await expect.element(screen.getByText("1 of 3 running · paused")).toBeVisible();
    await userEvent.click(screen.getByRole("switch", { name: "Pause the heavy work queue" }));
    expect(mocks.actions.setPaused).toHaveBeenCalledWith(false);
  });

  it("disables everything without permission", async () => {
    setup([entry("a"), entry("b")]);
    mocks.actions.canChange = false;
    await using screen = await render(group());
    await expect
      .element(screen.getByRole("switch", { name: "Pause the heavy work queue" }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Drag to reorder pnpm a" }))
      .toBeDisabled();
    await openMenu(screen, "b");
    await expect
      .element(screen.getByRole("menuitem", { name: "Remove from the queue" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  it("renders nothing for an empty queue, but still shows a paused one", async () => {
    setup([]);
    await using empty = await render(group());
    expect(empty.container.textContent).toBe("");
    setup([], { paused: true });
    await using paused = await render(group());
    await expect.element(paused.getByText("0 of 3 running · paused")).toBeVisible();
  });

  it("says the queue is off instead of looking idle, and offers to turn it back on", async () => {
    setup([], { enabled: false, paused: true });
    await using screen = await render(group());
    await expect.element(screen.getByText("Queue off: heavy jobs start right away")).toBeVisible();
    expect(screen.container.querySelector('[role="switch"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(mocks.actions.setEnabled).toHaveBeenCalledWith(true);
  });
});

describe("ResourceSegment", () => {
  it("shows how many commands wait in the heavy queue", async () => {
    setup([entry("a", { startedAt: "2026-01-01T00:00:00.000Z" }), entry("b")]);
    await using screen = await render(<ResourceSegment />);
    await expect.element(screen.getByLabelText("2 in heavy work queue")).toBeVisible();
  });

  it("marks a paused queue in the status bar even when it is empty", async () => {
    setup([], { paused: true });
    await using screen = await render(<ResourceSegment />);
    await expect.element(screen.getByLabelText("Heavy work queue paused")).toBeVisible();
  });

  it("counts running jobs while the queue is off, without the pause mark", async () => {
    setup([entry("a", { startedAt: "2026-01-01T00:00:00.000Z" })], {
      enabled: false,
      paused: true,
    });
    await using screen = await render(<ResourceSegment />);
    await expect.element(screen.getByLabelText("1 in heavy work queue")).toBeVisible();
    await expect.element(screen.getByLabelText("Heavy work queue paused")).not.toBeInTheDocument();
  });
});

const GIB = 1024 ** 3;
const command = (over: Partial<HeavyCommand>): HeavyCommand => ({
  source: "agent",
  pid: 12,
  startTimeMs: 1,
  threadId: "t1",
  label: "/usr/bin/node /work/app/node_modules/.bin/vp test run",
  name: "Tests",
  startedAt: "2026-01-01T00:00:00.000Z",
  stoppable: true,
  cpu: 2.5,
  memory: GIB,
  peakCpu: 3,
  peakMemory: 2 * GIB,
  ...over,
});

function setupCommands(commands: ReadonlyArray<HeavyCommand>, canStop = true) {
  mocks.commands = { commands, cpuCount: 8 };
  mocks.stop = { canStop, stop: vi.fn() };
  mocks.openThread.mockReset();
}

const commandsGroup = () => (
  <HeavyCommandsGroup
    environmentId={environmentId}
    threads={{
      threadTitle: (id) => (id === "t1" ? "Fix build" : undefined),
      projectIdOfThread: (id) => (id === "t1" ? "p2" : undefined),
      onOpenThread: mocks.openThread,
    }}
  />
);

describe("HeavyCommandsGroup", () => {
  it("renders nothing while no heavy command runs", async () => {
    setupCommands([]);
    await using screen = await render(commandsGroup());
    expect(screen.container.textContent).toBe("");
  });

  it("lists queued and direct commands with their project, thread, usage and run time", async () => {
    setupCommands([
      command({
        source: "queue",
        entryId: "q1",
        pid: 30,
        threadId: null,
        cwd: "/work/app/src",
        name: "Build",
        label: "pnpm build",
      }),
      command({}),
      command({ source: "terminal", pid: 40, threadId: "t-gone", name: "cargo build" }),
    ]);
    await using screen = await render(commandsGroup());
    await expect.element(screen.getByRole("button", { name: "Heavy commands (3)" })).toBeVisible();
    // The favicon mock repeats each project title, so those match twice.
    for (const text of ["Queued", "Agent", "Terminal", "App Project", "Package", "No project"]) {
      await expect.element(screen.getByText(text, { exact: true }).first()).toBeVisible();
    }
    // The row names the command; its full program line and peak usage live in tooltips.
    await userEvent.hover(screen.getByText("Tests", { exact: true }));
    await expect
      .element(screen.getByText(/^node \/work\/app\/node_modules\/\.bin\/vp test run · pid \d+$/))
      .toBeVisible();
    await userEvent.hover(screen.getByText("31%").nth(1));
    await expect.element(screen.getByText(/^Peak .+ · .+$/)).toBeVisible();
    expect(screen.getByText(/^· \d/).elements()).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Fix build" }));
    expect(mocks.openThread).toHaveBeenCalledWith("t1");
    await userEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(mocks.openThread).toHaveBeenLastCalledWith("t-gone");
  });

  it("stops a command from its row, but never server-held work", async () => {
    const server = command({ source: "queue", entryId: "s", name: "Checkpoint", stoppable: false });
    const tests = command({});
    setupCommands([server, tests]);
    await using screen = await render(commandsGroup());
    await expect.element(screen.getByRole("button", { name: "Stop Tests" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop Checkpoint" }).elements()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Stop Tests" }));
    expect(mocks.stop.stop).toHaveBeenCalledWith(tests);
  });

  it("offers no Stop without permission", async () => {
    setupCommands([command({})], false);
    await using screen = await render(commandsGroup());
    await expect.element(screen.getByText("Tests", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop Tests" }).elements()).toHaveLength(0);
  });
});
