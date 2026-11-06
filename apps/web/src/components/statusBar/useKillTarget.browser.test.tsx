import { RegistryProvider } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  promote: vi.fn(),
  cancel: vi.fn(),
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
      promote: { permissionAtom: () => allowed, name: "promote" },
      cancel: { permissionAtom: () => allowed, name: "cancel" },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { name: string }) => (args: unknown) => {
    (command.name === "promote" ? mocks.promote : mocks.cancel)(args);
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
  const { canPromote, canCancel, promote, cancel } = useHeavyQueueActions(environmentId);
  return (
    <>
      <output>{`${canPromote}/${canCancel}`}</output>
      <button onClick={() => void promote("a")}>promote</button>
      <button onClick={() => void cancel("b")}>cancel</button>
    </>
  );
}

function setup(over: { confirm?: boolean; failure?: boolean; interrupted?: boolean } = {}) {
  for (const mock of [mocks.promote, mocks.cancel, mocks.toast]) mock.mockReset();
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
  it("promotes straight away and cancels only after confirmation", async () => {
    await using screen = await setup();
    await expect.element(screen.getByRole("status")).toHaveTextContent("true/true");
    await userEvent.click(screen.getByRole("button", { name: "promote" }));
    expect(mocks.promote).toHaveBeenCalledWith({ environmentId, input: { id: "a" } });
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(mocks.cancel).toHaveBeenCalledWith({ environmentId, input: { id: "b" } });
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not cancel when the confirmation is declined", async () => {
    await using screen = await setup({ confirm: false });
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(mocks.confirm).toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a failure is reported", interrupted: false, toasts: 1 },
    { name: "an interruption is silent", interrupted: true, toasts: 0 },
  ])("$name", async ({ interrupted, toasts }) => {
    await using screen = await setup({ failure: true, interrupted });
    await userEvent.click(screen.getByRole("button", { name: "promote" }));
    await vi.waitFor(() => expect(mocks.promote).toHaveBeenCalled());
    expect(mocks.toast).toHaveBeenCalledTimes(toasts);
  });
});
