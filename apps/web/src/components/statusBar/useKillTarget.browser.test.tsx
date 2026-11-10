import { RegistryProvider } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
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

import { useHeavyQueueActions } from "./useKillTarget";

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
