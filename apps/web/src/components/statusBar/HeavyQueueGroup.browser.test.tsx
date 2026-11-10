import type { EnvironmentId, HeavyQueueEntry, HeavyQueueState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const mocks = vi.hoisted(() => ({
  actions: {
    move: vi.fn(),
    startNow: vi.fn(),
    cancel: vi.fn(),
    setPaused: vi.fn(),
    setRule: vi.fn(),
    setMaxRunning: vi.fn(),
    canChange: true,
  },
  state: null as unknown as HeavyQueueState,
  openThread: vi.fn(),
}));

vi.mock("../../state/heavyQueue", () => ({ useHeavyQueue: () => mocks.state }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "env", workspaceRoot: "/work/app", title: "App Project" },
    { environmentId: "env", workspaceRoot: "/work/app/pkg", title: "Package" },
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
}));

import { HeavyQueueGroup, ResourceSegment } from "./ResourceSegment";

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
    paused: false,
    rules: [],
    maxRunning: 3,
    reasons: {},
    room: true,
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
});
