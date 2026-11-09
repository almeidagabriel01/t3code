import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX,
  EnvironmentId,
  type DesktopTrayMenu,
} from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

const mocks = vi.hoisted(() => ({
  settings: { showInMenuBar: true },
  hydrated: true,
  settingsListeners: new Set<() => void>(),
  hydrationListeners: new Set<() => void>(),
}));
const atoms = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock("./hooks/useSettings", () => ({
  getClientSettings: () => mocks.settings,
  isClientSettingsHydrated: () => mocks.hydrated,
  subscribeClientSettings: (listener: () => void) => {
    mocks.settingsListeners.add(listener);
    return () => mocks.settingsListeners.delete(listener);
  },
  subscribeClientSettingsHydration: (listener: () => void) => {
    mocks.hydrationListeners.add(listener);
    return () => mocks.hydrationListeners.delete(listener);
  },
}));
vi.mock("./state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  atoms.shells = Atom.make<ReadonlyArray<unknown>>([]);
  return { environmentThreadShells: { quietThreadShellsAtom: atoms.shells } };
});
vi.mock("./state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  atoms.projects = Atom.make<ReadonlyArray<unknown>>([]);
  return { environmentProjects: { projectsAtom: atoms.projects } };
});
vi.mock("./state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  atoms.live = Atom.make<ReadonlySet<string>>(new Set<string>());
  return { liveShellEnvironmentIdsAtom: atoms.live };
});
vi.mock("./state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  atoms.identities = Atom.make<ReadonlyArray<unknown>>([]);
  return { environmentSummaries: { identitiesAtom: atoms.identities } };
});

import { deriveTrayMenu, parseTrayOpenThreadAction, startDesktopTray } from "./desktopTray";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

const shell = (
  id: string,
  extra: Record<string, unknown> = {},
  environmentId: EnvironmentId = envA,
) =>
  ({
    environmentId,
    id,
    projectId: "p1",
    title: `Title ${id}`,
    runtime: null,
    blockedOnThreadWait: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    archivedAt: null,
    sideChatOf: null,
    pinnedAt: null,
    pinOrderKey: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  }) as never;
const running = { runtime: { status: "running" } };
const projects = [{ environmentId: envA, id: "p1", title: "Project One" }] as never;
const live = new Set([envA]);
const ids = (rows: DesktopTrayMenu["attention"]) => rows.map((row) => row.threadId);

describe("deriveTrayMenu", () => {
  it.each([
    {
      name: "buckets by status",
      threads: [
        shell("approve", { hasPendingApprovals: true }),
        shell("input", { hasPendingUserInput: true }),
        shell("guest", { pendingGuestMessageCount: 1 }),
        shell("busy", running),
        shell("pin", { pinnedAt: "2026-01-02T00:00:00.000Z" }),
        shell("plain"),
      ],
      expected: { attention: ["approve", "input", "guest"], running: ["busy"], pinned: ["pin"] },
    },
    {
      name: "a thread lands in its first section only",
      threads: [shell("a", { ...running, hasPendingApprovals: true, pinnedAt: "x" })],
      expected: { attention: ["a"], running: [], pinned: [] },
    },
    {
      name: "drops archived, side chat and assistant threads",
      threads: [
        shell("gone", { archivedAt: "x", hasPendingApprovals: true }),
        shell("side", { sideChatOf: "parent", hasPendingApprovals: true }),
        shell("assistant:one", { hasPendingApprovals: true, pinnedAt: "x" }),
        shell("kept", { hasPendingApprovals: true }),
      ],
      expected: { attention: ["kept"], running: [], pinned: [] },
    },
    {
      name: "newest first for attention and running",
      threads: [
        shell("old", { ...running, updatedAt: "2026-01-01T00:00:00.000Z" }),
        shell("new", { ...running, updatedAt: "2026-03-01T00:00:00.000Z" }),
      ],
      expected: { attention: [], running: ["new", "old"], pinned: [] },
    },
    {
      name: "pinned follow the pin order",
      threads: [
        shell("b", { pinnedAt: "x", pinOrderKey: "b" }),
        shell("a", { pinnedAt: "x", pinOrderKey: "a" }),
      ],
      expected: { attention: [], running: [], pinned: ["a", "b"] },
    },
    {
      name: "a thread of an environment that is not live only shows as pinned",
      threads: [
        shell("stale", { ...running, hasPendingApprovals: true }, envB),
        shell("stalePin", { ...running, pinnedAt: "x" }, envB),
      ],
      expected: { attention: [], running: [], pinned: ["stalePin"] },
    },
  ])("$name", ({ threads, expected }) => {
    const result = deriveTrayMenu(threads, projects, live, null);
    expect({
      attention: ids(result.attention),
      running: ids(result.running),
      pinned: ids(result.pinned),
    }).toEqual(expected);
  });

  it("caps sections but counts every thread that needs you", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      shell(`t${i}`, { hasPendingApprovals: true }),
    );
    const result = deriveTrayMenu(many, projects, live, null);
    expect(result.attention).toHaveLength(20);
    expect(result.attentionCount).toBe(25);
  });

  it("labels rows with project, bounded text, and the environment only when given", () => {
    const long = "é".repeat(300);
    const [row] = deriveTrayMenu(
      [shell("a", { title: long, hasPendingApprovals: true }), shell("b", { projectId: "none" })],
      projects,
      live,
      new Map([[envA, "Laptop"]]),
    ).attention;
    expect(row).toEqual({
      environmentId: envA,
      threadId: "a",
      title: "é".repeat(200),
      project: "Project One",
      environment: "Laptop",
    });
    const unknown = deriveTrayMenu(
      [shell("b", { projectId: "none", hasPendingApprovals: true })],
      projects,
      live,
      null,
    ).attention[0];
    expect(unknown).toMatchObject({ project: null, environment: null });
  });
});

describe("parseTrayOpenThreadAction", () => {
  it.each([
    [`${DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX}{"environmentId":"e","threadId":"t"}`, "ok"],
    ["tray.new-thread", null],
    ["open-settings", null],
    [`${DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX}not json`, null],
    [`${DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX}null`, null],
    [`${DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX}{"environmentId":1,"threadId":"t"}`, null],
  ])("%s", (action, expected) => {
    expect(parseTrayOpenThreadAction(action)).toEqual(
      expected === "ok" ? { environmentId: "e", threadId: "t" } : null,
    );
  });
});

describe("startDesktopTray", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.settings = { showInMenuBar: true };
    mocks.hydrated = true;
  });

  const setup = (platform = "darwin") => {
    let menuListener: (action: string) => void = () => {};
    const setTrayMenu = vi.fn((_menu: DesktopTrayMenu | null) => Promise.resolve());
    vi.stubGlobal("window", {
      desktopBridge: {
        getClientPlatform: () => platform,
        setTrayMenu,
        onMenuAction: (listener: (action: string) => void) => {
          menuListener = listener;
          return () => {};
        },
      },
    });
    const registry = AtomRegistry.make();
    const navigate = vi.fn();
    const stop = startDesktopTray(registry, { navigate } as unknown as AnyRouter);
    const flush = () => Promise.resolve();
    return { registry, navigate, setTrayMenu, stop, flush, action: (a: string) => menuListener(a) };
  };

  it("does nothing outside macOS desktop", () => {
    const { setTrayMenu, stop } = setup("linux");
    stop();
    expect(setTrayMenu).not.toHaveBeenCalled();
    vi.stubGlobal("window", {});
    startDesktopTray(AtomRegistry.make(), {} as AnyRouter)();
  });

  it("publishes once per burst, skips repeats, and follows the setting", async () => {
    const { registry, setTrayMenu, stop, flush } = setup();
    await flush();
    expect(setTrayMenu).toHaveBeenCalledTimes(1);
    expect(setTrayMenu.mock.calls[0]![0]).toMatchObject({ attentionCount: 0 });

    registry.set(atoms.projects as Atom.Writable<ReadonlyArray<unknown>>, projects as never);
    registry.set(atoms.live as Atom.Writable<ReadonlySet<string>>, live);
    registry.set(atoms.shells as Atom.Writable<ReadonlyArray<unknown>>, [
      shell("a", { hasPendingApprovals: true }),
    ]);
    await flush();
    expect(setTrayMenu).toHaveBeenCalledTimes(2);
    expect(setTrayMenu.mock.calls[1]![0]).toMatchObject({ attentionCount: 1 });

    registry.set(atoms.projects as Atom.Writable<ReadonlyArray<unknown>>, [
      ...(projects as never[]),
    ]);
    await flush();
    expect(setTrayMenu).toHaveBeenCalledTimes(2);

    registry.set(atoms.identities as Atom.Writable<ReadonlyArray<unknown>>, [
      { environmentId: envA, label: "A" },
      { environmentId: envB, label: "B" },
    ]);
    await flush();
    expect(setTrayMenu.mock.calls[2]![0]!.attention[0]!.environment).toBe("A");

    mocks.settings = { showInMenuBar: false };
    mocks.settingsListeners.forEach((listener) => listener());
    await flush();
    expect(setTrayMenu).toHaveBeenLastCalledWith(null);

    stop();
    expect(mocks.settingsListeners.size).toBe(0);
  });

  it("waits for the saved setting, then publishes", async () => {
    mocks.hydrated = false;
    const { setTrayMenu, flush } = setup();
    await flush();
    expect(setTrayMenu).not.toHaveBeenCalled();
    mocks.hydrated = true;
    mocks.hydrationListeners.forEach((listener) => listener());
    await flush();
    expect(setTrayMenu).toHaveBeenCalledTimes(1);
  });

  it("sends again after a failed publish", async () => {
    const { setTrayMenu, flush } = setup();
    setTrayMenu.mockRejectedValueOnce(new Error("ipc"));
    await flush();
    await flush();
    mocks.settingsListeners.forEach((listener) => listener());
    await flush();
    expect(setTrayMenu).toHaveBeenCalledTimes(2);
  });

  it("opens the thread a row picks and ignores other actions", async () => {
    const { navigate, action, flush } = setup();
    await flush();
    action("tray.new-thread");
    action("tray.open-thread:garbage");
    expect(navigate).not.toHaveBeenCalled();
    action(`${DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX}{"environmentId":"e","threadId":"t"}`);
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "e", threadId: "t" },
    });
  });
});
