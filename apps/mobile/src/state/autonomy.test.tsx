import { DEFAULT_AUTONOMY_SETTINGS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, atoms } = vi.hoisted(() => {
  const atoms = {
    settings: (id: string) => ({ settingsFor: id }),
    upsert: { permissionAtom: (id: string) => ({ permissionFor: id }) },
    setEnabled: { name: "setEnabled" },
    remove: { name: "remove" },
    updateSettings: { name: "updateSettings" },
  };
  return {
    atoms,
    mocks: {
      settings: null as null | { autonomy: unknown },
      environmentIds: ["hub"] as string[],
      commands: new Map<unknown, ReturnType<typeof vi.fn>>(),
      runCommand: vi.fn(),
      refresh: vi.fn(),
      canAct: true,
    },
  };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { permissionFor?: string }) =>
    atom.permissionFor ? mocks.canAct : mocks.settings,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: mocks.runCommand,
}));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: { get: () => mocks.settings },
}));
vi.mock("./assistants", () => ({ useAssistantsEnvironmentIds: () => mocks.environmentIds }));
vi.mock("./query", () => ({ useEnvironmentQuery: () => ({ refresh: mocks.refresh }) }));
vi.mock("./server", () => ({
  serverEnvironment: {
    settingsValueAtom: atoms.settings,
    updateSettings: atoms.updateSettings,
    upsertAutonomyWatch: atoms.upsert,
    setAutonomyWatchEnabled: atoms.setEnabled,
    deleteAutonomyWatch: atoms.remove,
    autonomyWatches: () => ({}),
  },
}));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    let fn = mocks.commands.get(command);
    if (!fn) mocks.commands.set(command, (fn = vi.fn()));
    return fn;
  },
}));

import {
  toggleAutonomyPause,
  useAutonomyPause,
  useAutonomySettings,
  useAutonomyWatchActions,
} from "./autonomy";

let root: Root;
let container: HTMLDivElement;
function probe<T>(useHook: () => T): { current: T } {
  const result = {} as { current: T };
  const sink = (value: T) => {
    result.current = value;
  };
  const Probe = (props: { sink: (value: T) => void }) => {
    props.sink(useHook());
    return null;
  };
  act(() => root.render(<Probe sink={sink} />));
  return result;
}
const command = (atom: unknown) => mocks.commands.get(atom)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.settings = { autonomy: { ...DEFAULT_AUTONOMY_SETTINGS, enabled: true } };
  mocks.environmentIds = ["hub"];
  mocks.canAct = true;
  mocks.commands.clear();
  mocks.runCommand.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.refresh.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("autonomy settings hooks", () => {
  it("reads the server's settings, and writes the whole object as the patch", () => {
    const hook = probe(() => useAutonomySettings("hub" as never));
    expect(hook.current.autonomy.enabled).toBe(true);
    const next = { ...DEFAULT_AUTONOMY_SETTINGS, stuckMinutes: 5 };
    void hook.current.write(next);
    expect(command(atoms.updateSettings)).toHaveBeenCalledWith({
      environmentId: "hub",
      input: { patch: { autonomy: next } },
    });
  });

  it("falls back to the defaults with no server, and writes nothing", () => {
    mocks.settings = null;
    const hook = probe(() => useAutonomySettings(null));
    expect(hook.current.autonomy).toEqual(DEFAULT_AUTONOMY_SETTINGS);
    expect(hook.current.write(DEFAULT_AUTONOMY_SETTINGS)).toBeUndefined();
  });
});

describe("autonomy pause", () => {
  it("follows the first assistants server and flips only the switch, from the live settings", () => {
    const hook = probe(() => useAutonomyPause());
    expect(hook.current?.enabled).toBe(true);
    // Another edit lands after the hook rendered; the toggle must not undo it.
    mocks.settings = {
      autonomy: { ...DEFAULT_AUTONOMY_SETTINGS, enabled: true, stuckMinutes: 99 },
    };
    hook.current?.toggle();
    expect(mocks.runCommand.mock.calls[0]![2]).toEqual({
      environmentId: "hub",
      input: {
        patch: { autonomy: { ...DEFAULT_AUTONOMY_SETTINGS, enabled: false, stuckMinutes: 99 } },
      },
    });
  });

  it("is absent without an assistants server, and resumes from the defaults", () => {
    mocks.environmentIds = [];
    expect(probe(() => useAutonomyPause()).current).toBeNull();
    mocks.settings = null;
    void toggleAutonomyPause("hub" as never);
    expect(mocks.runCommand.mock.calls[0]![2].input.patch.autonomy).toEqual({
      ...DEFAULT_AUTONOMY_SETTINGS,
      enabled: !DEFAULT_AUTONOMY_SETTINGS.enabled,
    });
  });
});

describe("watch actions", () => {
  it("calls the matching command and refreshes only after a success", async () => {
    const hook = probe(() => useAutonomyWatchActions("hub" as never));
    expect(hook.current.canAct).toBe(true);
    command(atoms.upsert).mockResolvedValue({ _tag: "Success" });
    command(atoms.setEnabled).mockResolvedValue({ _tag: "Success" });
    command(atoms.remove).mockResolvedValue({ _tag: "Success" });
    const input = { assistantId: "a1", title: "CI" } as never;
    await expect(hook.current.save(input)).resolves.toEqual({ ok: true });
    expect(command(atoms.upsert)).toHaveBeenCalledWith({ environmentId: "hub", input });
    await hook.current.setEnabled("w1" as never, false);
    expect(command(atoms.setEnabled)).toHaveBeenCalledWith({
      environmentId: "hub",
      input: { id: "w1", enabled: false },
    });
    await hook.current.remove("w1" as never);
    expect(command(atoms.remove)).toHaveBeenCalledWith({
      environmentId: "hub",
      input: { id: "w1" },
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
  });

  it("settles a refusal into its message without refreshing", async () => {
    const hook = probe(() => useAutonomyWatchActions("hub" as never));
    command(atoms.upsert).mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Too many watches")),
    });
    await expect(hook.current.save({} as never)).resolves.toEqual({
      ok: false,
      message: "Too many watches",
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
