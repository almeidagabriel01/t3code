import {
  HEAVY_QUEUE_DEFAULTS,
  linuxOverText,
  type EnvironmentId,
  type HeavyCommand,
  type HeavyCommandsState,
  type HeavyQueueEntry,
  type HeavyQueueState,
  type HeavyRunnerLinux,
  type HeavyRunnerLinuxOver,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
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
    setPriority: vi.fn(),
    route: vi.fn(),
    moveAll: vi.fn(),
    canChange: true,
    canRoute: true,
    canRouteAll: true,
  },
  state: null as unknown as HeavyQueueState,
  commands: { commands: [], cpuCount: 8 } as HeavyCommandsState,
  stop: { canStop: true, stop: vi.fn() },
  openThread: vi.fn(),
}));

vi.mock("../../state/heavyQueue", async () => ({
  resourceManagerOpenAtom: (await import("effect/reactivity")).Atom.make(false),
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
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => false,
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

import { HeavyWorkSection } from "./HeavyQueueBody";
import { MachineBar } from "./MachineBar";
import { ResourceSegment } from "./ResourceSegment";

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

function setup(
  entries: ReadonlyArray<HeavyQueueEntry>,
  over: Partial<HeavyQueueState> = {},
  commands: ReadonlyArray<HeavyCommand> = [],
) {
  localStorage.clear();
  for (const key of [
    "move",
    "startNow",
    "cancel",
    "setEnabled",
    "setPaused",
    "setRule",
    "setMaxRunning",
    "setPriority",
    "route",
    "moveAll",
  ] as const) {
    mocks.actions[key].mockReset();
  }
  mocks.openThread.mockReset();
  mocks.actions.canChange = true;
  mocks.actions.canRoute = true;
  mocks.actions.canRouteAll = true;
  mocks.commands = { commands, cpuCount: 8 };
  mocks.stop = { canStop: true, stop: vi.fn() };
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
    hold: null,
    linux: null,
    macOnly: [],
    routes: {},
    ...HEAVY_QUEUE_DEFAULTS,
    ...over,
  };
}

const LINUX = {
  host: "remoto",
  online: true,
  slots: 2,
  running: 1,
  cpuPercent: 20,
  load1: 1.2,
  cpuCount: 6,
  availableMemoryBytes: 8 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
};
const MACHINE = {
  busyCores: 2,
  cpuCount: 8,
  availableMemoryBytes: 3.4 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
  pressureLevel: null,
  swapInBytesPerSecond: null,
};
const STARTED = "2026-01-01T00:00:00.000Z";
const GIB = 1024 ** 3;

const title = (id: string) => (id === "t1" ? "Fix build" : undefined);
const group = () => (
  <HeavyWorkSection
    environmentId={environmentId}
    commands={mocks.commands.commands}
    cpuCount={mocks.commands.cpuCount}
    threads={{
      threadTitle: title,
      projectIdOfThread: (id) => (id === "t1" ? "p2" : undefined),
      onOpenThread: mocks.openThread,
    }}
  />
);
const openMenu = (screen: Awaited<ReturnType<typeof render>>, label: string) =>
  userEvent.click(screen.getByRole("button", { name: `Actions for pnpm ${label}` }));
const expand = (screen: Awaited<ReturnType<typeof render>>, name: string) =>
  userEvent.click(screen.getByRole("button", { name, exact: true }));

describe("HeavyWorkSection", () => {
  it("expands a row to every fact, and shows the same facts in its tooltip", async () => {
    setup(
      [
        entry("test", {
          startedAt: STARTED,
          threadId: "t1",
          name: "Server tests",
          cpu: 2,
          memory: 3 * GIB,
          peakCpu: 3,
          peakMemory: 4 * GIB,
          qos: "background",
        }),
        entry("build", { note: "Moved by the user", unconfirmed: true }),
        entry("e2e"),
      ],
      {
        reasons: { build: "needs ~4.0 GB; 4.4 GB free, 3.2 GB kept spare" },
        rules: [{ root: "/work/app", priority: "first" }],
        estimates: { e2e: { cpu: 4, memoryBytes: 3 * GIB, durationMs: 120_000 } },
        machine: MACHINE,
      },
    );
    await using screen = await render(group());
    // Only the waiting reason earns a second line; places and the project chip sit on line one.
    await expect
      .element(screen.getByText("needs ~4.0 GB; 4.4 GB free, 3.2 GB kept spare"))
      .toBeVisible();
    await expect.element(screen.getByText(/^1st · /)).toBeVisible();
    await expect.element(screen.getByText(/^2nd · /)).toBeVisible();
    expect(screen.container.querySelectorAll('[data-testid="favicon"]')).toHaveLength(3);
    expect(screen.container.textContent).not.toContain("Moved by the user");
    // The running job uses 2 of 8 cores, in the shared CPU and Memory columns.
    await expect.element(screen.getByText("25%", { exact: true })).toBeVisible();

    await userEvent.hover(screen.getByRole("button", { name: "pnpm build", exact: true }));
    await expect.element(screen.getByText("Moved by the user")).toBeVisible();

    const running = screen.getByRole("button", { name: "Server tests", exact: true });
    await userEvent.click(running);
    await expect.element(running).toHaveAttribute("aria-expanded", "true");
    for (const text of [
      "pnpm test",
      "/work/app/src",
      "This Mac",
      "Project: Always first · Low priority",
      "Using 2.0 cores (25%) · 3.0 GB · peak 3.0 cores · 4.0 GB",
      "pid 1",
    ]) {
      await expect.element(screen.getByText(text, { exact: true }).last()).toBeVisible();
    }
    await userEvent.click(screen.getByRole("button", { name: "Fix build" }));
    expect(mocks.openThread).toHaveBeenCalledWith("t1");

    await expand(screen, "pnpm build");
    for (const text of [
      "Moved by the user",
      "Linux has not confirmed the earlier run stopped.",
      "needs ~4.0 GB; 4.4 GB free, 3.2 GB kept spare",
    ]) {
      await expect.element(screen.getByText(text, { exact: true }).last()).toBeVisible();
    }
    await expand(screen, "pnpm e2e");
    await expect.element(screen.getByText("Usually ~4.0 cores · 3.0 GB · 2 min")).toBeVisible();
    await expand(screen, "pnpm e2e");
    await expect
      .element(screen.getByRole("button", { name: "pnpm e2e", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    { menu: "e2e", item: "Run next", expected: ["e2e", "build"] },
    { menu: "e2e", item: "Move up", expected: ["e2e", "build"] },
    { menu: "build", item: "Move down", expected: ["build", "lint"] },
    { menu: "build", item: "Move to end", expected: ["build", null] },
  ])("$item on $menu moves it", async ({ menu, item, expected }) => {
    setup([entry("run", { startedAt: STARTED }), entry("build"), entry("e2e"), entry("lint")]);
    await using screen = await render(group());
    await openMenu(screen, menu);
    await userEvent.click(screen.getByRole("menuitem", { name: item }));
    expect(mocks.actions.move).toHaveBeenCalledWith(...expected);
  });

  it("starts a waiter now from its menu, which the running job does not offer", async () => {
    setup([entry("run", { startedAt: STARTED }), entry("b")]);
    await using screen = await render(group());
    await openMenu(screen, "run");
    expect(screen.getByRole("menuitem", { name: "Start now" }).elements()).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await openMenu(screen, "b");
    await userEvent.click(screen.getByRole("menuitem", { name: "Start now" }));
    expect(mocks.actions.startNow).toHaveBeenCalledWith("b");
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
    setup([entry("run", { startedAt: STARTED, threadId: "t1" }), entry("b")]);
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
  });

  it.each([
    ["Last", "last"],
    ["Normal", null],
  ] as const)("sets the project's priority to %s from the menu", async (name, priority) => {
    setup([entry("a"), entry("b")], { rules: [{ root: "/work/app", priority: "first" }] });
    await using screen = await render(group());
    await openMenu(screen, "a");
    await userEvent.click(screen.getByRole("menuitemradio", { name }));
    expect(mocks.actions.setRule).toHaveBeenCalledWith("/work/app", priority);
  });

  it("offers a running job only the CPU change that applies, and a waiter high priority", async () => {
    setup([
      entry("run", { startedAt: STARTED, priority: "low", qos: "normal" }),
      entry("b", { priority: "high" }),
    ]);
    await using screen = await render(group());
    await openMenu(screen, "b");
    expect(screen.getByRole("menuitem", { name: "High priority now" }).elements()).toHaveLength(0);
    expect(screen.getByRole("menuitem", { name: "Lower priority" }).elements()).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await openMenu(screen, "run");
    expect(screen.getByRole("menuitem", { name: "High priority now" }).elements()).toHaveLength(0);
    await userEvent.click(screen.getByRole("menuitem", { name: "Lower priority" }));
    expect(mocks.actions.setPriority).toHaveBeenCalledWith("run", "low");
  });

  it("pauses and resumes from the header, keeping the section collapsed", async () => {
    setup([entry("a", { startedAt: STARTED })], { paused: true });
    await using screen = await render(group());
    await expect.element(screen.getByLabelText("This Mac: 1 of 3 running")).toBeVisible();
    const pause = screen.getByRole("button", { name: "Pause the heavy work queue" });
    await expect.element(pause).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(pause);
    expect(mocks.actions.setPaused).toHaveBeenCalledWith(false);
    // The pause sits above the header's toggle, so pressing it never folds the section.
    await expect
      .element(screen.getByRole("button", { name: "Heavy work (1)" }))
      .toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "Heavy work (1)" }));
    await expect.element(screen.getByText("pnpm a", { exact: true })).not.toBeInTheDocument();
  });

  it("disables everything without permission", async () => {
    setup([entry("a"), entry("b")]);
    mocks.actions.canChange = false;
    await using screen = await render(group());
    await expect
      .element(screen.getByRole("button", { name: "Pause the heavy work queue" }))
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
    await expect.element(paused.getByLabelText("This Mac: 0 of 3 running")).toBeVisible();
  });

  it("groups jobs by machine, each running first and then waiting in its own line", async () => {
    setup(
      [
        entry("m1"),
        entry("l1"),
        entry("mrun", { startedAt: STARTED }),
        entry("m2"),
        entry("lrun", { startedAt: STARTED, runner: "linux", phase: "installing" }),
        entry("l2"),
      ],
      { linux: LINUX, routes: { l1: "linux", l2: "linux" } },
      [command({ name: "Agent tests", pid: 50 })],
    );
    await using screen = await render(group());
    expect(screen.container.textContent).toMatch(
      /This Mac.*pnpm mrun.*Agent tests.*pnpm m1.*1st · .*pnpm m2.*2nd · .*Linux.*pnpm lrun.*Installing.*pnpm l1.*1st · .*pnpm l2.*2nd · /s,
    );
    await expect.element(screen.getByLabelText("This Mac: 1 of 3 running")).toBeVisible();
    await expect.element(screen.getByLabelText("Linux: 1 of 2 running")).toBeVisible();
    // A Linux job's usage is not this Mac's to show.
    await expand(screen, "pnpm lrun");
    await expect.element(screen.getByText("Linux (remoto) · Installing")).toBeVisible();
    expect(screen.getByText("Usage", { exact: true }).elements()).toHaveLength(0);
  });

  it("counts Linux's running jobs under Linux, never as the Mac's", async () => {
    setup(
      [
        entry("l1", { startedAt: STARTED, runner: "linux", phase: "running" }),
        entry("l2", { startedAt: STARTED, runner: "linux", phase: "syncing" }),
      ],
      { linux: { ...LINUX, running: 2 } },
      [
        command({ source: "queue", entryId: "l1", name: "pnpm l1", pid: 61 }),
        command({ source: "queue", entryId: "l2", name: "pnpm l2", pid: 62 }),
      ],
    );
    await using screen = await render(group());
    await expect.element(screen.getByLabelText("This Mac: 0 of 3 running")).toBeVisible();
    await expect.element(screen.getByLabelText("Linux: 2 of 2 running")).toBeVisible();
    expect(screen.getByRole("group", { name: "This Mac" }).elements()).toHaveLength(0);
    expect(screen.getByText("pnpm l1", { exact: true }).elements()).toHaveLength(1);
    await expect.element(screen.getByText("Syncing", { exact: true })).toBeVisible();
  });

  it("keeps a job that still runs on Linux after the Runner went off, under Linux", async () => {
    setup([entry("l", { startedAt: STARTED, runner: "linux" })]);
    await using screen = await render(group());
    await expect.element(screen.getByLabelText("This Mac: 0 of 3 running")).toBeVisible();
    await expect.element(screen.getByLabelText("Linux: 1 running")).toBeVisible();
    await expect
      .element(screen.getByRole("group", { name: "Linux" }).getByText("pnpm l", { exact: true }))
      .toBeVisible();
  });

  it("moves a waiter within its machine's line from the menu", async () => {
    setup([entry("m1"), entry("l1"), entry("m2")], { linux: LINUX, routes: { l1: "linux" } });
    await using screen = await render(group());
    await openMenu(screen, "l1");
    await expect
      .element(screen.getByRole("menuitem", { name: "Run next" }))
      .toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
    await openMenu(screen, "m2");
    await userEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(mocks.actions.move).toHaveBeenCalledWith("m2", "m1");
  });

  it.each([
    // Lands right after m2 in the Mac's line, ahead of the Mac's next waiter.
    { onto: "m2", over: "m2", expected: ["m1", "m3"] },
    // The Linux line is not a drop target for a Mac waiter: it lands at the end of its own line.
    { onto: "l1", over: "m3", expected: ["m1", null] },
  ])("drags a waiter onto $onto and keeps it on its machine", async ({ onto, over, expected }) => {
    setup([entry("m1"), entry("m2"), entry("l1"), entry("m3")], {
      linux: LINUX,
      routes: { l1: "linux" },
    });
    await using screen = await render(group());
    const grip = screen.getByRole("button", { name: "Drag to reorder pnpm m1" }).element();
    const from = grip.getBoundingClientRect();
    const to = screen.getByText(`pnpm ${onto}`, { exact: true }).element().getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    const live = () =>
      [...document.querySelectorAll("[aria-live]")].map((node) => node.textContent).join(" ");
    const x = from.x + from.width / 2;
    grip.dispatchEvent(pointer("pointerdown", x, from.y + from.height / 2));
    document.dispatchEvent(pointer("pointermove", x, from.y + from.height / 2 + 10));
    await vi.waitFor(() => expect(live()).toContain("Draggable item m1"));
    const y = to.y + to.height / 2;
    document.dispatchEvent(pointer("pointermove", x, y));
    await vi.waitFor(() => expect(live()).toContain(`over droppable area ${over}`));
    document.dispatchEvent(pointer("pointerup", x, y));
    await vi.waitFor(() => expect(mocks.actions.move).toHaveBeenCalledTimes(1));
    expect(mocks.actions.move).toHaveBeenCalledWith(...expected);
  });

  it("moves jobs between this Mac and Linux from the menu, with the confirmation each needs", async () => {
    setup([entry("run", { startedAt: STARTED }), entry("w", { unconfirmed: true })], {
      linux: LINUX,
      routes: { w: "linux" },
    });
    await using screen = await render(group());
    await openMenu(screen, "run");
    await expect.element(screen.getByRole("menuitem", { name: "Run on Linux" })).toBeVisible();
    expect(document.body.textContent).not.toContain("Run on this Mac");
    await userEvent.click(screen.getByRole("menuitem", { name: "Run on Linux" }));
    await openMenu(screen, "w");
    await userEvent.click(screen.getByRole("menuitem", { name: "Run on this Mac" }));
    expect(mocks.actions.route.mock.calls).toEqual([
      [
        "run",
        expect.objectContaining({
          runner: "linux",
          confirm: expect.stringContaining("Stop this job"),
          force: false,
        }),
      ],
      [
        "w",
        expect.objectContaining({
          runner: "mac",
          confirm: expect.stringContaining("may run it twice"),
          force: true,
        }),
      ],
    ]);
  });

  it("offers no move while the Runner is off", async () => {
    setup([entry("w")]);
    await using screen = await render(group());
    await openMenu(screen, "w");
    await expect.element(screen.getByRole("menuitem", { name: "Move to end" })).toBeVisible();
    expect(document.body.textContent).not.toContain("Run on");
  });

  it("greys moves out without the route permission", async () => {
    setup([entry("w")], { linux: LINUX });
    mocks.actions.canRoute = false;
    await using screen = await render(group());
    await openMenu(screen, "w");
    await expect
      .element(screen.getByRole("menuitem", { name: "Run on Linux" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  it("moves every waiting job to the other machine from each machine's header, and back", async () => {
    setup([entry("run", { startedAt: STARTED }), entry("m"), entry("l")], {
      linux: LINUX,
      routes: { l: "linux" },
    });
    await using screen = await render(group());
    const mac = screen.getByRole("group", { name: "This Mac" });
    const linux = screen.getByRole("group", { name: "Linux" });
    await userEvent.click(mac.getByRole("button", { name: "Move all to Linux" }));
    await userEvent.click(linux.getByRole("button", { name: "Move all to this Mac" }));
    expect(mocks.actions.moveAll.mock.calls).toEqual([["linux"], ["mac"]]);
    expect(mac.element().textContent).not.toContain("Move all to this Mac");
  });

  it("offers Move all only where a job would move, and greys it without the permission", async () => {
    setup([entry("m", { where: "mac" })], { linux: LINUX });
    {
      await using _none = await render(group());
      expect(document.body.textContent).not.toContain("Move all");
    }

    setup([entry("m")], { linux: LINUX });
    mocks.actions.canRouteAll = false;
    await using greyed = await render(group());
    await expect.element(greyed.getByRole("button", { name: "Move all to Linux" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("Move all to this Mac");
  });

  it("asks where to run with a live countdown, and answers or cancels from the row", async () => {
    setup(
      [entry("w", { ask: { reason: "unavailable", deadlineAt: "2026-01-01T00:11:05.000Z" } })],
      { linux: LINUX, routes: { w: "linux" } },
    );
    // The countdown reads the clock on its first render, so the clock is faked before it.
    using _timers = fakeTimers({ now: new Date("2026-01-01T00:10:00.000Z") });
    await using screen = await render(group());
    const ask = screen.getByRole("group", { name: "Linux is unavailable" }).element();
    expect(ask.textContent).toContain("1:05");
    await act(() => vi.advanceTimersByTime(1_000));
    expect(ask.textContent).toContain("1:04");
    await userEvent.click(screen.getByRole("button", { name: "Run on this Mac" }));
    await userEvent.click(screen.getByRole("button", { name: "Wait for Linux" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.actions.route.mock.calls).toEqual([
      ["w", expect.objectContaining({ runner: "mac", confirm: null, force: false })],
      ["w", expect.objectContaining({ runner: "linux", confirm: null, force: false })],
    ]);
    expect(mocks.actions.cancel).toHaveBeenCalledWith("w", false);
  });

  it("labels each row with its class and why, and keeps a stopped agent's place with Stop", async () => {
    setup([entry("run", { startedAt: STARTED }), entry("w"), entry("o", { orphanedAt: 0 })], {
      reasons: { w: "all 3 slots busy" },
      costs: {
        run: { class: "quick", why: "usually 4 s" },
        w: { class: "standard", why: "first run" },
        o: { class: "service", why: "dev server" },
      },
      order: { w: { code: "first-run", text: "first run: after known ones" } },
    });
    using _timers = fakeTimers({ now: new Date(3 * 60_000) });
    await using screen = await render(group());
    const text = screen.container.textContent ?? "";
    expect(text).toMatch(
      /pnpm run.*Quick · .*pnpm w.*Job · 1st · .*all 3 slots busy.*pnpm o.*Keeps running · /s,
    );
    const kept = screen.getByRole("group", { name: "Stopped agent's place" }).element();
    expect(kept.textContent).toContain("Waiting for the agent to ask again · 7 min left");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(mocks.actions.cancel).toHaveBeenCalledWith("o", false);
    await expand(screen, "pnpm w");
    await expect.element(screen.getByText("Job · first run")).toBeVisible();
    await expect.element(screen.getByText("first run: after known ones")).toBeVisible();
  });

  it("offers an orphan no start, move or route, only Stop", async () => {
    setup([entry("w"), entry("o", { orphanedAt: 0 })]);
    await using screen = await render(group());
    await openMenu(screen, "o");
    await expect.element(screen.getByRole("menuitem", { name: "Stop" })).toBeVisible();
    for (const name of ["Start now", "Run next", "Move up", "Move to end"]) {
      expect(screen.getByRole("menuitem", { name }).elements()).toHaveLength(0);
    }
    await userEvent.click(screen.getByRole("menuitem", { name: "Stop" }));
    expect(mocks.actions.cancel).toHaveBeenCalledWith("o", false);
  });

  it("answers a dropped, unconfirmed job pinned to Linux without forcing a rerun", async () => {
    setup(
      [
        entry("d", {
          ask: { reason: "dropped", deadlineAt: "2026-01-01T00:11:05.000Z" },
          route: "linux",
          unconfirmed: true,
        }),
      ],
      { linux: LINUX, routes: { d: "linux" } },
    );
    await using screen = await render(group());
    await expect
      .element(screen.getByRole("group", { name: "Linux dropped this job mid-run" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Wait for Linux" }));
    expect(mocks.actions.route).toHaveBeenCalledWith(
      "d",
      expect.objectContaining({ runner: "linux", confirm: null, force: false }),
    );
  });

  it("says the queue is off instead of looking idle, and offers to turn it back on", async () => {
    setup([], { enabled: false, paused: true });
    await using screen = await render(group());
    expect(
      screen.getByRole("button", { name: "Pause the heavy work queue" }).elements(),
    ).toHaveLength(0);
    await userEvent.hover(screen.getByRole("button", { name: "Turn on" }));
    await expect.element(screen.getByText("Queue off: heavy jobs start right away")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(mocks.actions.setEnabled).toHaveBeenCalledWith(true);
  });
});

const machineBar = () => <MachineBar environmentId={environmentId} t3={null} />;
const hoverHint = async (screen: Awaited<ReturnType<typeof render>>, label: string) => {
  await userEvent.hover(screen.getByLabelText(label).first());
};

describe("MachineBar", () => {
  it("shows each machine's CPU, free memory and slots from one reading", async () => {
    setup(
      [entry("mrun", { startedAt: STARTED }), entry("l", { startedAt: STARTED, runner: "linux" })],
      {
        linux: LINUX,
        machine: MACHINE,
      },
    );
    await using screen = await render(machineBar());
    const text = screen.container.textContent ?? "";
    expect(text).toMatch(/This Mac.*25%.*3\.4 GB.*free.*1\/3.*Linux.*20%.*8\.0 GB.*free.*1\/2/s);
    expect(screen.container.querySelector("[data-warn]")).toBeNull();
    await hoverHint(screen, "1 of 3 running on this Mac");
    await expect.element(screen.getByText("1 of 3 running on this Mac").last()).toBeVisible();
    await userEvent.hover(screen.getByText("20%"));
    await expect.element(screen.getByText("20% CPU in use · load 1.2 on 6 cores")).toBeVisible();
    await userEvent.hover(screen.getByLabelText("Linux online"));
    await expect.element(screen.getByText("remoto · online")).toBeVisible();
  });

  it.each([
    ["memory low", "memory-floor", "3.4 GB free of 16.0 GB · waiting: memory low"],
    ["CPU busy", "cpu", "CPU 25% · 2.0 of 8 cores busy · waiting: CPU busy"],
  ] as const)("colours the gauge %s is about and words it there", async (_name, hold, hint) => {
    setup([entry("w")], { machine: MACHINE, hold });
    await using screen = await render(machineBar());
    expect(screen.container.querySelectorAll("[data-warn]")).toHaveLength(1);
    await userEvent.hover(screen.getByText(hold === "cpu" ? "25%" : "3.4 GB", { exact: true }));
    await expect.element(screen.getByText(hint)).toBeVisible();
    expect(screen.container.textContent).not.toContain("waiting:");
  });

  it.each([
    ["the pause", { paused: true }, "0 of 3 running on this Mac · paused"],
    [
      "a slot hold",
      { hold: "slots" as const },
      "0 of 3 running on this Mac · waiting: all 3 slots busy",
    ],
  ])("puts %s on the Mac's slots", async (_name, over, hint) => {
    setup([entry("w")], { machine: MACHINE, ...over });
    await using screen = await render(machineBar());
    expect(screen.container.querySelector("[data-warn]")).toBeNull();
    await hoverHint(screen, hint);
    await expect.element(screen.getByText(hint).last()).toBeVisible();
  });

  it.each([
    [
      "offline",
      { ...LINUX, online: false, error: "ssh timed out" },
      "Offline",
      "remoto · offline · ssh timed out",
    ],
    ["being checked", { ...LINUX, online: null }, "Checking…", "remoto · checking"],
  ])("shows Linux %s instead of stale readings", async (_name, linux, shown, hint) => {
    setup([], { linux, machine: MACHINE });
    await using screen = await render(machineBar());
    await expect.element(screen.getByText(shown, { exact: true })).toBeVisible();
    expect(screen.container.textContent).not.toContain("8.0 GB");
    await userEvent.hover(screen.getByText(shown, { exact: true }));
    await expect.element(screen.getByText(hint).last()).toBeVisible();
  });

  it("counts a running quick job apart from the job slots", async () => {
    setup([entry("q", { startedAt: STARTED }), entry("j", { startedAt: STARTED })], {
      machine: MACHINE,
      costs: { q: { class: "quick", why: "staged files" } },
    });
    await using screen = await render(machineBar());
    await expect
      .element(screen.getByLabelText("1 of 2 quick jobs running on this Mac", { exact: true }))
      .toHaveTextContent("1/2");
    expect(screen.container.textContent).toMatch(/1\/2.*1\/3/s);
  });

  const over = (...overLimits: ReadonlyArray<HeavyRunnerLinuxOver>): HeavyRunnerLinux => ({
    ...LINUX,
    status: "over-limit",
    overLimitBy: linuxOverText(overLimits[0]!),
    overLimits,
  });
  it.each<[string, HeavyRunnerLinux, string | null, string]>([
    [
      "over limits",
      over(
        { limit: "memory", value: 8 * 1024 ** 3, threshold: 10 },
        { limit: "swap", value: 0.2 * 1024 ** 3, threshold: 10, total: 4 * 1024 ** 3 },
      ),
      "8.0 GB",
      "remoto · over limits · keeping 10% of memory free; swap nearly full: 205 MB of 4.0 GB free",
    ],
    [
      "over limits",
      over({ limit: "cpu-pressure", value: 95, threshold: 90 }),
      "20%",
      "remoto · over limits · CPU saturated: work waited 95% of the time",
    ],
    [
      "not responding",
      { ...LINUX, status: "unresponsive", error: "ssh timed out" },
      null,
      "remoto · not responding · ssh timed out",
    ],
    [
      "offline",
      { ...LINUX, online: false, status: "offline", error: "ssh timed out" },
      null,
      "remoto · offline · ssh timed out",
    ],
  ])(
    "Tab to Linux's %s dot reads why, warning only its gauge",
    async (chip, linux, warned, hint) => {
      setup([], { linux, machine: MACHINE });
      await using screen = await render(machineBar());
      // This Mac's CPU, memory and slots come first in tab order.
      await userEvent.keyboard("{Tab}{Tab}{Tab}{Tab}");
      await expect.element(screen.getByLabelText(`Linux ${chip}`)).toHaveFocus();
      await expect.element(screen.getByText(hint).last()).toBeVisible();
      const warns = [...screen.container.querySelectorAll("[data-warn]")];
      expect(
        warns.map((meter) => meter.closest('[data-slot="tooltip-trigger"]')?.textContent),
      ).toEqual(warned === null ? [] : [expect.stringContaining(warned)]);
    },
  );

  it("says the queue is off on the Mac's slots, and shows no Linux without the Runner", async () => {
    setup([], { enabled: false, machine: MACHINE });
    await using screen = await render(machineBar());
    await expect.element(screen.getByText("Off", { exact: true })).toBeVisible();
    expect(screen.container.textContent).not.toContain("Linux");
    await userEvent.hover(screen.getByText("Off", { exact: true }));
    await expect.element(screen.getByText("Queue off: heavy jobs start right away")).toBeVisible();
  });

  it("shows T3's own total, never above the Mac's CPU", async () => {
    setup([], { machine: MACHINE });
    await using screen = await render(
      <MachineBar
        environmentId={environmentId}
        t3={{ cpuPercent: 60, rssBytes: 2 * GIB, processCount: 4 }}
      />,
    );
    await expect.element(screen.getByText("T3 total")).toBeVisible();
    expect(screen.container.textContent).toContain("2.00 GB");
    expect(screen.container.textContent?.match(/25%/g)).toHaveLength(2);
  });
});

describe("ResourceSegment", () => {
  it("shows how many commands wait in the heavy queue", async () => {
    setup([entry("a", { startedAt: STARTED }), entry("b")]);
    await using screen = await render(<ResourceSegment />);
    await expect.element(screen.getByLabelText("2 in heavy work queue")).toBeVisible();
  });

  it("marks a paused queue in the status bar even when it is empty", async () => {
    setup([], { paused: true });
    await using screen = await render(<ResourceSegment />);
    await expect.element(screen.getByLabelText("Heavy work queue paused")).toBeVisible();
  });

  it("counts running jobs while the queue is off, without the pause mark", async () => {
    setup([entry("a", { startedAt: STARTED })], { enabled: false, paused: true });
    await using screen = await render(<ResourceSegment />);
    await expect.element(screen.getByLabelText("1 in heavy work queue")).toBeVisible();
    await expect.element(screen.getByLabelText("Heavy work queue paused")).not.toBeInTheDocument();
  });
});

const command = (over: Partial<HeavyCommand>): HeavyCommand => ({
  source: "agent",
  pid: 12,
  startTimeMs: 1,
  threadId: "t1",
  label: "/usr/bin/node /work/app/node_modules/.bin/vp test run",
  name: "Tests",
  startedAt: STARTED,
  stoppable: true,
  cpu: 2.5,
  memory: GIB,
  peakCpu: 3,
  peakMemory: 2 * GIB,
  ...over,
});

describe("heavy commands in Heavy work", () => {
  it("lists each job once: a queue command is its entry, and a command on a job's pid is that job", async () => {
    setup([entry("q", { startedAt: STARTED, pid: 30, name: "Build" })], {}, [
      command({ source: "queue", entryId: "q", pid: 30, name: "Build", label: "pnpm q" }),
      command({ pid: 30, name: "Build" }),
      command({ source: "terminal", pid: 40, threadId: "t-gone", name: "cargo build" }),
      command({ source: "detached", pid: 50, threadId: null, stoppable: false, name: "Stray" }),
    ]);
    await using screen = await render(group());
    expect(screen.getByText("Build", { exact: true }).elements()).toHaveLength(1);
    await expect.element(screen.getByText("cargo build")).toBeVisible();
    // Detached work lives under Outside T3, not here.
    expect(screen.getByText("Stray").elements()).toHaveLength(0);
    await expect.element(screen.getByRole("button", { name: "Heavy work (2)" })).toBeVisible();
  });

  it("expands a direct command to its program, thread, source, usage and peak", async () => {
    setup([], {}, [command({})]);
    await using screen = await render(group());
    // 2.5 of 8 cores, in the shared columns.
    await expect.element(screen.getByText("31%", { exact: true })).toBeVisible();
    await expand(screen, "Tests");
    for (const text of [
      "/usr/bin/node /work/app/node_modules/.bin/vp test run",
      "Agent",
      "Using 2.5 cores (31%) · 1.0 GB · peak 3.0 cores · 2.0 GB",
      "pid 12",
    ]) {
      await expect.element(screen.getByText(text, { exact: true })).toBeVisible();
    }
    await userEvent.click(screen.getByRole("button", { name: "Fix build" }));
    expect(mocks.openThread).toHaveBeenCalledWith("t1");
  });

  it("stops a command from its menu, but never server-held work", async () => {
    const tests = command({});
    setup([entry("s", { startedAt: STARTED, server: true, name: "Checkpoint" })], {}, [tests]);
    await using screen = await render(group());
    await userEvent.click(screen.getByRole("button", { name: "Actions for Checkpoint" }));
    await expect
      .element(screen.getByRole("menuitem", { name: "Stop" }))
      .toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Actions for Tests" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Stop" }));
    expect(mocks.stop.stop).toHaveBeenCalledWith(tests);
  });

  it("offers no Stop without permission, only the thread", async () => {
    setup([], {}, [command({})]);
    mocks.stop = { canStop: false, stop: vi.fn() };
    await using screen = await render(group());
    await userEvent.click(screen.getByRole("button", { name: "Actions for Tests" }));
    await expect.element(screen.getByRole("menuitem", { name: "Open thread" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Stop" }).elements()).toHaveLength(0);
  });
});
