import type {
  EnvironmentId,
  ProjectId,
  ResourceTelemetryProcess,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
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
vi.mock("../../state/heavyQueue", () => ({
  useHeavyQueue: () => ({ entries: [] }),
  useHeavyCommands: () => ({ commands: [], cpuCount: 1 }),
}));
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
  useProjects: () => [{ environmentId: "env", id: "p1", title: "My project" }],
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

function setup() {
  closeTerminal.mockReset();
  hostResources.current = null;
  deviceState.current = { hosts: [], devices: [] };
  return {
    resources: { environmentId, label: "Local", terminals: [terminal] },
    threadInfo: new Map([
      [`${environmentId}:t1`, { projectId, title: "Fix build", working: true }],
    ]),
    projectTitleById: new Map([[projectId, "My project"]]),
  } as never as {
    resources: Parameters<typeof EnvironmentSection>[0]["resources"];
    threadInfo: Parameters<typeof EnvironmentSection>[0]["threadInfo"];
    projectTitleById: Parameters<typeof EnvironmentSection>[0]["projectTitleById"];
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

  it("lists simulators outside T3 in their own section, by the device list's name", async () => {
    const props = setup();
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
    } as unknown as ResourceTelemetrySnapshot;
    await using screen = await render(
      <EnvironmentSection {...props} snapshot={withSimulator} sort="memory" label={null} />,
      { router: "/" },
    );
    await expect.element(screen.getByRole("button", { name: /^Devices outside T3/ })).toBeVisible();
    await expect.element(screen.getByText("iPhone 17 Pro")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /^Devices \(/ })).toBeVisible();
    await expect.element(screen.getByText("Pixel 8")).toBeVisible();
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

  it("labels the whole Mac and T3 separately, with T3 never above the Mac and no Host row", async () => {
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
    await expect.element(screen.getByText(/^Mac/)).toBeVisible();
    await expect.element(screen.getByText("T3", { exact: true })).toBeVisible();
    const text = screen.container.textContent ?? "";
    expect(text).toContain("16.00 GB total");
    expect(text).toContain("12.00 GB");
    expect(text.match(/40%/g)).toHaveLength(2);
    expect(text).not.toContain("50%");
    expect(text).not.toContain("Host");
    expect(text).not.toContain("free of");
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
      live.snapshot = agentSnapshot(byRank);
      await using screen = await render(<ResourceSegment />, { router: "/" });
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
      await screen.rerender(<ResourceSegment />);
      await expect.element(page.getByText(painted, { exact: true }).first()).toBeInTheDocument();

      expect(Math.round(offset())).toBe(Math.round(before.offset));
      if (!expandFirst) expect(scroller.scrollTop).toBe(before.scrollTop);
      if (focusRow) expect(document.activeElement).toBe(toggle.element());
    },
  );

  it("keeps a collapsed section collapsed after the popup closes and reopens", async () => {
    using _storage = { [Symbol.dispose]: () => localStorage.clear() };
    localStorage.clear();
    live.snapshot = agentSnapshot(byRank);
    await using screen = await render(<ResourceSegment />, { router: "/" });
    const trigger = screen.getByRole("button", { name: "Resource Manager" });
    const section = page.getByRole("button", { name: /^My project/ });
    await userEvent.click(trigger);
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
