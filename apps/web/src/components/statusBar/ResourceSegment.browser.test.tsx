import type {
  EnvironmentId,
  ProjectId,
  ResourceTelemetryProcess,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

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
}));
vi.mock("../../state/heavyQueue", () => ({ useHeavyQueue: () => ({ entries: [] }) }));
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
}));

import { EnvironmentSection } from "./ResourceSegment";

const environmentId = "env" as EnvironmentId;
const projectId = "p1" as ProjectId;

const proc = (
  pid: number,
  childPids: number[],
  residentBytes: number,
  name = "node",
  command = name,
) =>
  ({
    identity: { pid, startTimeMs: 0 },
    childPids,
    residentBytes,
    cpuPercent: 10,
    category: "server-child",
    name,
    command,
  }) as unknown as ResourceTelemetryProcess;

const snapshot = {
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
  return {
    resources: { environmentId, label: "Local", terminals: [terminal] },
    threadInfo: new Map([[`${environmentId}:t1`, { projectId, title: "Fix build" }]]),
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
    await expect.element(screen.getByText("Mac", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("T3", { exact: true })).toBeVisible();
    const text = screen.container.textContent ?? "";
    expect(text).toContain("40% CPU");
    expect(text).toContain("12.0 GB / 16.0 GB");
    expect(text).not.toContain("50% CPU");
    expect(text).not.toContain("Host");
    expect(text).not.toContain("free of");
  });
});
