import {
  HEAVY_QUEUE_DEFAULTS,
  type EnvironmentId,
  type HeavyCommand,
  type HeavyQueueState,
  type ProjectId,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import { RegistryProvider } from "@effect/atom-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
// The scroll behavior under test comes from the real layout classes.
import "../../index.css";

const closeTerminal = vi.hoisted(() => vi.fn());
const HOST_QUERY = "host-query";
const hostResources = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("./useKillTarget", () => ({
  useCloseTerminal: () => ({ canClose: true, close: closeTerminal }),
  useShutDownDevice: () => ({ canShutDown: false, shutDown: vi.fn() }),
  useHeavyQueueActions: () => ({
    canPromote: false,
    canCancel: false,
    promote: vi.fn(),
    cancel: vi.fn(),
  }),
  useStopHeavyCommand: () => ({ canStop: false, stop: vi.fn() }),
}));
const deviceState = vi.hoisted(() => ({ current: { hosts: [], devices: [] } as unknown }));
vi.mock("../../state/device", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/device")>()),
  useDeviceState: () => ({
    state: deviceState.current,
    loaded: true,
    error: null,
    refresh: () => undefined,
  }),
}));
const EMPTY_QUEUE: HeavyQueueState = {
  entries: [],
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
};
const heavy = vi.hoisted(() => ({
  queue: null as unknown as HeavyQueueState,
  commands: [] as ReadonlyArray<HeavyCommand>,
}));
vi.mock("../../state/heavyQueue", async () => ({
  resourceManagerOpenAtom: (await import("effect/reactivity")).Atom.make(false),
  useHeavyQueue: () => heavy.queue,
  useHeavyCommands: () => ({ commands: heavy.commands, cpuCount: 8 }),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
const live = vi.hoisted(() => ({
  snapshot: null as unknown,
  threads: Array.from({ length: 40 }, (_, index) => ({
    environmentId: "env",
    id: `t${index}`,
    projectId: "p1",
    title: `Thread ${index}`,
    runtime: { status: "running" },
  })),
}));
vi.mock("./useEnvironmentResources", () => ({
  useEnvironmentResources: () => [{ environmentId: "env", label: "Local", terminals: [] }],
  useEnvironmentSnapshots: () => new Map([["env", live.snapshot]]),
}));
vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  useProjects: () => [
    { environmentId: "env", id: "p1", title: "My project", workspaceRoot: "/work/mine" },
  ],
  useThreadShells: () => live.threads,
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "env",
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({ statusBarHiddenItems: [], statusBarResourceSort: "cpu" }),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/server")>();
  return {
    ...original,
    serverEnvironment: { ...original.serverEnvironment, hostResources: () => HOST_QUERY },
  };
});
vi.mock("../../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/query")>()),
  useEnvironmentQuery: (query: unknown) => ({
    data: query === HOST_QUERY ? hostResources.current : null,
    refresh: () => undefined,
  }),
  useEnvironmentQuerySelector: () => null,
}));

import { EnvironmentSection, ResourceSegment } from "./ResourceSegment";

const environmentId = "env" as EnvironmentId;
const projectId = "p1" as ProjectId;

const proc = (
  pid: number,
  childPids: number[],
  residentBytes: number,
  name = "node",
  command = name,
  category: ResourceTelemetryProcess["category"] = "server-child",
) =>
  ({
    identity: { pid, startTimeMs: 0 },
    childPids,
    residentBytes,
    cpuPercent: 10,
    category,
    name,
    command,
  }) as unknown as ResourceTelemetryProcess;

const snapshot = {
  groups: { allT3: { currentCpuPercent: 1, currentRssBytes: 6_000_000, processCount: 3 } },
  processes: [
    proc(10, [], 1_000_000),
    proc(20, [21], 2_000_000),
    proc(21, [], 3_000_000),
    proc(40, [41], 1_000_000),
    proc(41, [], 5_000_000, "emulator", "emulator -avd Pixel_8"),
  ],
  owners: [
    { kind: "agent", pid: 20, threadId: "t1" },
    { kind: "device-hub", pid: 40 },
  ],
} as unknown as ResourceTelemetrySnapshot;

const terminal = {
  target: { threadId: "t1", terminalId: "term" },
  state: {
    status: "running",
    hasRunningSubprocess: true,
    summary: { label: "dev", cwd: "/w", pid: 10 },
  },
};

function setup(queue: Partial<HeavyQueueState> = {}, commands: ReadonlyArray<HeavyCommand> = []) {
  closeTerminal.mockReset();
  hostResources.current = null;
  deviceState.current = { hosts: [], devices: [] };
  heavy.queue = { ...EMPTY_QUEUE, ...queue };
  heavy.commands = commands;
  return {
    resources: { environmentId, label: "Local", terminals: [terminal] },
    threadInfo: new Map([
      [`${environmentId}:t1`, { projectId, title: "Fix build", working: true }],
    ]),
    projectById: new Map([
      [
        projectId,
        { environmentId, id: projectId, title: "My project", workspaceRoot: "/work/mine" },
      ],
    ]),
  } as never as {
    resources: Parameters<typeof EnvironmentSection>[0]["resources"];
    threadInfo: Parameters<typeof EnvironmentSection>[0]["threadInfo"];
    projectById: Parameters<typeof EnvironmentSection>[0]["projectById"];
  };
}

describe("EnvironmentSection", () => {
  it("groups the agent, terminal and device under their project and Devices, and opens a thread", async () => {
    const props = setup();
    await using screen = await render(
      <EnvironmentSection {...props} snapshot={snapshot} sort="memory" label="Local" />,
      { router: "/" },
    );
    await expect.element(screen.getByRole("button", { name: /My project/ })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Fix build" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /^dev/ })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Devices/ })).toBeVisible();
    await expect.element(screen.getByText("Pixel 8")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Fix build" }));
    expect(screen.router?.state.location.pathname).toContain("t1");
    await userEvent.click(screen.getByRole("button", { name: "End terminal dev" }), {
      force: true,
    });
    expect(closeTerminal).toHaveBeenCalledWith({ threadId: "t1", terminalId: "term" }, "dev");

    // A finished agent keeps its provider session warm for follow-ups; the row must not read as working.
    await screen.rerender(
      <EnvironmentSection
        {...props}
        threadInfo={
          new Map([[`${environmentId}:t1`, { projectId, title: "Fix build", working: false }]])
        }
        snapshot={snapshot}
        sort="memory"
        label="Local"
      />,
    );
    await expect.element(screen.getByRole("button", { name: "Fix build · idle" })).toBeVisible();
  });

  it("merges devices and detached commands outside T3 into one section", async () => {
    const props = setup({}, [
      {
        source: "detached",
        pid: 90,
        startTimeMs: 1,
        threadId: null,
        label: "/usr/local/bin/playwright test",
        name: "playwright test",
        startedAt: "2026-01-01T00:00:00.000Z",
        stoppable: false,
        cpu: 1,
        memory: 1024 ** 3,
        reason: "Started outside an agent, so the queue can't route it",
      },
    ]);
    const udid = "C7ECB864-1C0B-4E4D-B0E7-0B7037305D4B";
    deviceState.current = {
      hosts: [{ id: "local", kind: "local" }],
      devices: [
        { hostId: "local", id: udid, platform: "ios", name: "iPhone 17 Pro", booted: true },
      ],
    };
    const withSimulator = {
      ...snapshot,
      processes: [
        ...snapshot.processes,
        proc(
          70,
          [71],
          1_000_000,
          "launchd_sim",
          `launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap.plist`,
          "external-device",
        ),
        proc(71, [], 9_000_000, "SpringBoard", "SpringBoard", "external-device"),
      ],
      outsideApps: [
        { name: "Google Chrome", cpuPercent: 20, rssBytes: 2_000_000, processCount: 12 },
      ],
    } as unknown as ResourceTelemetrySnapshot;
    await using screen = await render(
      <EnvironmentSection {...props} snapshot={withSimulator} sort="memory" label={null} />,
      { router: "/" },
    );
    const outside = screen.getByRole("region", { name: "Outside T3" });
    await expect.element(outside.getByRole("button", { name: "Outside T3 (3)" })).toBeVisible();
    await expect.element(outside.getByText("iPhone 17 Pro")).toBeVisible();
    await expect.element(outside.getByText("Google Chrome")).toBeVisible();
    await expect.element(outside.getByText("playwright test")).toBeVisible();
    // Detached work has no Stop and no thread, so it has no menu; why it is here is one click away.
    expect(outside.getByRole("button", { name: /^Actions for/ }).elements()).toHaveLength(0);
    await userEvent.click(outside.getByRole("button", { name: "playwright test" }));
    await expect
      .element(outside.getByText("Started outside an agent, so the queue can't route it"))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: /^Devices \(/ })).toBeVisible();
    await expect.element(screen.getByText("Pixel 8")).toBeVisible();
    expect(screen.getByRole("region", { name: "Heavy work" }).elements()).toHaveLength(0);
  });

  it("expands a row to list its processes with usage and the full command", async () => {
    const props = setup();
    const deep = {
      ...snapshot,
      processes: [
        proc(10, [11], 1_000_000, "zsh", 'zsh -c "npm run dev"'),
        {
          ...proc(11, [], 2 * 1024 ** 3, "node", "node /x/node_modules/vite/bin/vite.js"),
          cpuPercent: 80,
        },
      ],
      owners: [],
    } as unknown as ResourceTelemetrySnapshot;
    await using screen = await render(
      <EnvironmentSection {...props} snapshot={deep} sort="memory" label={null} />,
      { router: "/" },
    );
    expect(screen.container.textContent).not.toContain("vite");
    const toggle = screen.getByRole("button", { name: /processes of dev/ });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("vite", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("npm run dev", { exact: true })).toBeVisible();
    expect(screen.container.querySelector("[data-heavy]")?.textContent).toContain("vite");
    await userEvent.hover(screen.getByText("vite", { exact: true }));
    await expect
      .element(screen.getByText("node /x/node_modules/vite/bin/vite.js · pid 11"))
      .toBeVisible();
    await userEvent.click(toggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("says nothing is running and shows no usage before the first sample", async () => {
    const props = setup();
    await using screen = await render(
      <EnvironmentSection
        {...props}
        resources={{ ...props.resources, terminals: [] }}
        snapshot={null}
        sort="cpu"
        label={null}
      />,
      { router: "/" },
    );
    await expect.element(screen.getByText("Nothing running right now")).toBeVisible();
  });

  it("shows the Mac's reading and T3's total in the machine bar, T3 never above the Mac", async () => {
    const props = setup();
    hostResources.current = {
      cpuUtilization: 0.4,
      cpuCount: 8,
      availableMemoryBytes: 4 * 1024 ** 3,
      totalMemoryBytes: 16 * 1024 ** 3,
    };
    const busy = {
      ...snapshot,
      groups: { allT3: { currentCpuPercent: 50, currentRssBytes: 5 * 1024 ** 3, processCount: 5 } },
    } as unknown as ResourceTelemetrySnapshot;
    await using screen = await render(
      <EnvironmentSection {...props} snapshot={busy} sort="memory" label={null} />,
      { router: "/" },
    );
    const bar = screen.getByRole("group", { name: "Machines" });
    await expect.element(bar.getByText("This Mac")).toBeVisible();
    await expect.element(bar.getByText("T3 total")).toBeVisible();
    const text = bar.element().textContent ?? "";
    expect(text).toContain("4.0 GB");
    expect(text).toContain("5.00 GB");
    expect(text.match(/40%/g)).toHaveLength(2);
    expect(text).not.toContain("50%");
  });

  it("orders sections Heavy work, Projects, Devices, T3 Code, Outside T3; an unread CPU is a dash", async () => {
    const props = setup({
      entries: [
        {
          id: "job",
          pid: 5,
          threadId: null,
          label: "pnpm test",
          cwd: "/work/mine",
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          // The sample read its memory but not its CPU.
          memory: 112 * 1024 ** 2,
        },
      ],
    });
    deviceState.current = { hosts: [], devices: [] };
    const all = {
      ...snapshot,
      processes: [
        ...snapshot.processes,
        proc(
          80,
          [],
          1_000_000,
          "launchd_sim",
          "launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/C7ECB864-1C0B-4E4D-B0E7-0B7037305D4B/data/var/run/launchd_bootstrap.plist",
          "external-device",
        ),
      ],
    } as unknown as ResourceTelemetrySnapshot;
    await using screen = await render(
      <EnvironmentSection {...props} snapshot={all} sort="memory" label={null} />,
      { router: "/" },
    );
    await expect.element(screen.getByRole("region", { name: "Outside T3" })).toBeVisible();
    expect(
      [...screen.container.querySelectorAll("section")].map((node) =>
        node.getAttribute("aria-label"),
      ),
    ).toEqual(["Heavy work", "My project", "Devices", "T3 Code", "Outside T3"]);
    const heavy = screen.getByRole("region", { name: "Heavy work" });
    await expect.element(heavy.getByLabelText("CPU reading unavailable")).toHaveTextContent("--");
    await expect.element(heavy.getByText("112 MB")).toBeVisible();
  });
});

const AGENTS = live.threads.length;
/** One agent per thread; the first can own an extra child process. */
const agentSnapshot = (cpuOf: (index: number) => number, firstChild = false) =>
  ({
    cpuCount: 1,
    groups: { allT3: { currentCpuPercent: 1, currentRssBytes: 1_000_000, processCount: AGENTS } },
    processes: [
      ...Array.from({ length: AGENTS }, (_, index) => ({
        ...proc(100 + index, index === 0 && firstChild ? [999] : [], 1_000_000),
        cpuPercent: cpuOf(index),
      })),
      ...(firstChild ? [{ ...proc(999, [], 1_000_000, "child"), cpuPercent: 1 }] : []),
    ],
    owners: Array.from({ length: AGENTS }, (_, index) => ({
      kind: "agent",
      pid: 100 + index,
      threadId: `t${index}`,
    })),
  }) as unknown as ResourceTelemetrySnapshot;
const byRank = (index: number) => 60 - index;

function scrollerOf(element: Element): HTMLElement {
  let node = element.parentElement;
  while (node !== null && getComputedStyle(node).overflowY !== "auto") node = node.parentElement;
  if (node === null) throw new Error("no scroll container");
  return node;
}

// A fresh registry per test: the default one keeps the popup's open atom until a scheduled
// cleanup, so the next test would mount it already open.
const isolated = () => (
  <RegistryProvider>
    <ResourceSegment />
  </RegistryProvider>
);

describe("ResourceManager scroll", () => {
  it.each([
    {
      name: "a row in view climbs to the top",
      next: agentSnapshot((index) => (index === 15 ? 99 : byRank(index))),
      painted: "99%",
    },
    {
      name: "a focused row in view drops to the bottom",
      focusRow: true,
      next: agentSnapshot((index) => (index === 15 ? 0.5 : byRank(index))),
      painted: "0.5%",
    },
    {
      name: "an expanded process list above grows",
      expandFirst: true,
      next: agentSnapshot(byRank, true),
      painted: "child",
    },
  ])(
    "keeps the rows in view still when $name",
    async ({ next, painted, focusRow, expandFirst }) => {
      setup();
      live.snapshot = agentSnapshot(byRank);
      await using screen = await render(isolated(), { router: "/" });
      await userEvent.click(screen.getByRole("button", { name: "Resource Manager" }));
      if (expandFirst)
        await userEvent.click(page.getByRole("button", { name: /processes of Thread 0$/ }));
      const row = page.getByRole("button", { name: "Thread 15", exact: true });
      await expect.element(row).toBeVisible();
      const scroller = scrollerOf(row.element());
      const offset = () =>
        row.element().getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      await act(async () => {
        const scrolled = new Promise((resolve) =>
          scroller.addEventListener("scroll", resolve, { once: true }),
        );
        scroller.scrollTop += offset();
        await scrolled;
      });
      expect(scroller.scrollTop).toBeGreaterThan(0);
      const toggle = page.getByRole("button", { name: /processes of Thread 15$/ });
      if (focusRow) toggle.element().focus();
      const before = { offset: offset(), scrollTop: scroller.scrollTop };

      live.snapshot = next;
      await screen.rerender(isolated());
      await expect.element(page.getByText(painted, { exact: true }).first()).toBeInTheDocument();

      expect(Math.round(offset())).toBe(Math.round(before.offset));
      if (!expandFirst) expect(scroller.scrollTop).toBe(before.scrollTop);
      if (focusRow) expect(document.activeElement).toBe(toggle.element());
    },
  );

  it("keeps a collapsed section collapsed after the popup closes and reopens", async () => {
    using _storage = { [Symbol.dispose]: () => localStorage.clear() };
    localStorage.clear();
    setup();
    live.snapshot = agentSnapshot(byRank);
    await using screen = await render(isolated(), { router: "/" });
    const trigger = screen.getByRole("button", { name: "Resource Manager" });
    const section = page.getByRole("button", { name: /^My project/ });
    await userEvent.click(trigger);
    await expect.element(page.getByRole("button", { name: "Thread 0", exact: true })).toBeVisible();
    await userEvent.click(section);
    await expect.element(section).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{Escape}");
    await expect.element(section).not.toBeInTheDocument();
    await userEvent.click(trigger);
    await expect.element(section).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByRole("button", { name: "Thread 0", exact: true }))
      .not.toBeInTheDocument();
  });
});
