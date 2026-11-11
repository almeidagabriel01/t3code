import { RegistryProvider } from "@effect/atom-react";
import type { EnvironmentId, HeavyCommand } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  calls: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  result: { _tag: "Success" } as { _tag: string },
  interrupted: false,
}));

vi.mock("../../state/heavyQueue", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    heavyQueueEnvironment: {
      move: { permissionAtom: () => allowed, name: "move" },
      cancel: { permissionAtom: () => allowed, name: "cancel" },
      stopCommand: { permissionAtom: () => allowed, name: "stopCommand" },
      setPaused: { permissionAtom: () => allowed, name: "setPaused" },
      setEnabled: { permissionAtom: () => allowed, name: "setEnabled" },
      setRule: { permissionAtom: () => allowed, name: "setRule" },
      setMaxRunning: { permissionAtom: () => allowed, name: "setMaxRunning" },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { name: string }) => (args: unknown) => {
    mocks.calls(command.name, args);
    return Promise.resolve(mocks.result);
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  isAtomCommandInterrupted: () => mocks.interrupted,
  squashAtomCommandFailure: () => new Error("boom"),
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: mocks.toast },
}));

import { useHeavyQueueActions, useStopHeavyCommand } from "./useKillTarget";

const environmentId = "env" as EnvironmentId;

function Probe() {
  const actions = useHeavyQueueActions(environmentId);
  return (
    <>
      <output>{String(actions.canChange)}</output>
      <button onClick={() => void actions.move("a", "b")}>move</button>
      <button onClick={() => void actions.cancel("b", false)}>cancel</button>
      <button onClick={() => void actions.cancel("c", true)}>stop</button>
      <button onClick={() => void actions.setPaused(true)}>pause</button>
      <button onClick={() => void actions.setEnabled(false)}>off</button>
      <button onClick={() => void actions.setRule("/p", "first")}>rule</button>
      <button onClick={() => void actions.setMaxRunning(2)}>max</button>
      <StopProbe />
    </>
  );
}

const command = (over: Partial<HeavyCommand>): HeavyCommand => ({
  source: "agent",
  pid: 12,
  startTimeMs: 34,
  threadId: "t1",
  label: "vp test",
  name: "Tests",
  startedAt: "2026-01-01T00:00:00.000Z",
  stoppable: true,
  ...over,
});

function StopProbe() {
  const { canStop, stop } = useStopHeavyCommand(environmentId);
  return (
    <>
      <span data-testid="can-stop">{String(canStop)}</span>
      <button onClick={() => void stop(command({}))}>stop direct</button>
      <button onClick={() => void stop(command({ source: "queue", entryId: "q1" }))}>
        stop queued
      </button>
    </>
  );
}

function setup(over: { confirm?: boolean; failure?: boolean; interrupted?: boolean } = {}) {
  for (const mock of [mocks.calls, mocks.toast]) mock.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(over.confirm ?? true);
  mocks.result = { _tag: over.failure ? "Failure" : "Success" };
  mocks.interrupted = over.interrupted ?? false;
  return render(
    <RegistryProvider>
      <Probe />
    </RegistryProvider>,
    { router: false }, // no routes involved
  );
}

describe("useHeavyQueueActions", () => {
  it("sends each change straight away, and removes or stops only after confirmation", async () => {
    await using screen = await setup();
    await expect.element(screen.getByRole("status")).toHaveTextContent("true");
    for (const name of ["move", "pause", "off", "rule", "max", "cancel", "stop"]) {
      await userEvent.click(screen.getByRole("button", { name }));
    }
    expect(mocks.calls.mock.calls).toEqual([
      ["move", { environmentId, input: { id: "a", beforeId: "b" } }],
      ["setPaused", { environmentId, input: { paused: true } }],
      ["setEnabled", { environmentId, input: { enabled: false } }],
      ["setRule", { environmentId, input: { root: "/p", priority: "first" } }],
      ["setMaxRunning", { environmentId, input: { maxRunning: 2 } }],
      ["cancel", { environmentId, input: { id: "b" } }],
      ["cancel", { environmentId, input: { id: "c" } }],
    ]);
    expect(mocks.confirm.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("Remove from the queue"),
      expect.stringContaining("Stop the running command"),
    ]);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("stops a direct command by its process identity and a queued one through the queue", async () => {
    await using screen = await setup();
    await expect.element(screen.getByTestId("can-stop")).toHaveTextContent("true");
    await userEvent.click(screen.getByRole("button", { name: "stop direct" }));
    await userEvent.click(screen.getByRole("button", { name: "stop queued" }));
    expect(mocks.calls.mock.calls).toEqual([
      ["stopCommand", { environmentId, input: { pid: 12, startTimeMs: 34 } }],
      ["cancel", { environmentId, input: { id: "q1" } }],
    ]);
    expect(mocks.confirm.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('Stop "Tests"?'),
      expect.stringContaining('Stop "Tests"?'),
    ]);
  });

  it.each([
    { name: "declined, nothing is sent", confirm: false, failure: false, calls: 0, toasts: 0 },
    { name: "a failed stop is reported", confirm: true, failure: true, calls: 1, toasts: 1 },
  ])("stop: $name", async ({ confirm, failure, calls, toasts }) => {
    await using screen = await setup({ confirm, failure });
    await userEvent.click(screen.getByRole("button", { name: "stop direct" }));
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await vi.waitFor(() => expect(mocks.calls).toHaveBeenCalledTimes(calls));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(toasts));
  });

  it("does not cancel when the confirmation is declined", async () => {
    await using screen = await setup({ confirm: false });
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(mocks.confirm).toHaveBeenCalled();
    expect(mocks.calls).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a failure is reported", interrupted: false, toasts: 1 },
    { name: "an interruption is silent", interrupted: true, toasts: 0 },
  ])("$name", async ({ interrupted, toasts }) => {
    await using screen = await setup({ failure: true, interrupted });
    await userEvent.click(screen.getByRole("button", { name: "move" }));
    await vi.waitFor(() => expect(mocks.calls).toHaveBeenCalled());
    expect(mocks.toast).toHaveBeenCalledTimes(toasts);
  });
});
