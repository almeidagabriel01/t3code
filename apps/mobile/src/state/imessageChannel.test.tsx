import { act } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    event: null as unknown,
    stored: null as unknown,
    command: vi.fn(),
    failure: null as unknown,
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "status"
      ? mocks.event
        ? AsyncResult.success(mocks.event)
        : AsyncResult.initial()
      : true,
}));
vi.mock("@t3tools/client-runtime/state/imessageChannel", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createImessageChannelEnvironmentAtoms: () => ({
    settings: () => "settings",
    access: () => "access",
    status: () => "status",
    configure: { permissionAtom: () => "permission" },
  }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => mocks.failure,
}));
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const { Layer } = await import("effect");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: string) =>
    atom === "settings"
      ? { data: mocks.stored, error: null }
      : { data: { access: "ok" }, refresh: vi.fn() },
}));

import { ImessageChannelSettingsError } from "@t3tools/contracts";
import { environmentServerConfigsAtom } from "./server";
import { imessageEnvironmentIdsAtom, useImessageChannel } from "./imessageChannel";

const config = (imessageChannel?: boolean) =>
  ({ environment: { capabilities: { imessageChannel } } }) as never;

describe("imessageEnvironmentIdsAtom", () => {
  it("lists only environments whose server has the capability", () => {
    const registry = AtomRegistry.make();
    registry.set(
      environmentServerConfigsAtom as never,
      new Map([
        ["mac", config(true)],
        ["linux", config(false)],
        ["old", config(undefined)],
      ]),
    );
    expect(registry.get(imessageEnvironmentIdsAtom)).toEqual(["mac"]);
    registry.set(environmentServerConfigsAtom as never, new Map());
    expect(registry.get(imessageEnvironmentIdsAtom)).toEqual([]);
  });
});

describe("useImessageChannel", () => {
  const seen: Array<ReturnType<typeof useImessageChannel>> = [];
  const latest = () => seen.at(-1)!;
  const mount = () => {
    const root = createRoot(window.document.createElement("div"));
    function Probe() {
      seen.push(useImessageChannel("mac" as never));
      return null;
    }
    act(() => root.render(<Probe />));
    return root;
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.event = null;
    mocks.stored = { enabled: false, allowedHandles: [], selfHandles: [], status: "disabled" };
  });
  afterEach(() => vi.clearAllMocks());

  it("lays the live status over the stored settings and exposes access", () => {
    mocks.event = { status: "error", lastError: "automation_denied" };
    const root = mount();
    expect(latest().settings).toMatchObject({ status: "error", lastError: "automation_denied" });
    expect(latest().access).toBe("ok");
    expect(latest().canConfigure).toBe(true);
    act(() => root.unmount());
  });

  it("shows the saved settings after a change and names the rejected handle on failure", async () => {
    const root = mount();
    mocks.command.mockResolvedValueOnce({
      _tag: "Success",
      value: { enabled: true, allowedHandles: [], selfHandles: ["+1"], status: "running" },
    });
    await act(async () => {
      expect(await latest().configure({ enabled: true })).toEqual({ ok: true });
    });
    expect(latest().settings).toMatchObject({ enabled: true, status: "running" });
    mocks.command.mockResolvedValueOnce({ _tag: "Failure" });
    mocks.failure = new ImessageChannelSettingsError({ reason: "invalid_handle", detail: "bad" });
    expect(await latest().configure({ selfHandles: ["bad"] })).toEqual({
      ok: false,
      message: "bad: That is not a phone number with country code (+...) or an email address.",
    });
    mocks.command.mockResolvedValueOnce({ _tag: "Failure" });
    mocks.failure = "boom";
    expect(await latest().configure({})).toEqual({
      ok: false,
      message: "The request could not be completed.",
    });
    act(() => root.unmount());
  });
});
