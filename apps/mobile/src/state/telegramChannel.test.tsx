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
vi.mock("@t3tools/client-runtime/state/telegramChannel", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createTelegramChannelEnvironmentAtoms: () => ({
    settings: () => "settings",
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
  useEnvironmentQuery: () => ({ data: mocks.stored, error: null }),
}));

import { TelegramChannelSettingsError } from "@t3tools/contracts";
import { environmentServerConfigsAtom } from "./server";
import {
  telegramEnvironmentIdsAtom,
  useTelegramChannel,
  useTelegramEnvironmentIds,
} from "./telegramChannel";

const config = (telegramChannel?: boolean) =>
  ({ environment: { capabilities: { telegramChannel } } }) as never;

describe("telegramEnvironmentIdsAtom", () => {
  it("lists only environments whose server has the capability", () => {
    const registry = AtomRegistry.make();
    registry.set(
      environmentServerConfigsAtom as never,
      new Map([
        ["new", config(true)],
        ["old", config(undefined)],
        ["off", config(false)],
      ]),
    );
    const first = registry.get(telegramEnvironmentIdsAtom);
    expect(first).toEqual(["new"]);
    // The same list keeps its identity, so screens do not re-render for nothing.
    registry.set(
      environmentServerConfigsAtom as never,
      new Map([
        ["new", config(true)],
        ["old", config(undefined)],
      ]),
    );
    expect(registry.get(telegramEnvironmentIdsAtom)).toBe(first);
    registry.set(environmentServerConfigsAtom as never, new Map());
    expect(registry.get(telegramEnvironmentIdsAtom)).toEqual([]);
  });

  it("is read through the hook", () => {
    const seen: Array<ReadonlyArray<string>> = [];
    const root = createRoot(window.document.createElement("div"));
    function Probe() {
      seen.push(useTelegramEnvironmentIds());
      return null;
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.render(<Probe />));
    expect(seen.at(-1)).toBeDefined();
    act(() => root.unmount());
  });
});

describe("useTelegramChannel", () => {
  const seen: Array<ReturnType<typeof useTelegramChannel>> = [];
  const latest = () => seen.at(-1)!;
  const mount = () => {
    const root = createRoot(window.document.createElement("div"));
    function Probe() {
      seen.push(useTelegramChannel("hub" as never));
      return null;
    }
    act(() => root.render(<Probe />));
    return root;
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.event = null;
    mocks.stored = {
      enabled: false,
      tokenConfigured: false,
      allowedUserIds: [],
      status: "disabled",
    };
  });
  afterEach(() => vi.clearAllMocks());

  it("lays the live status over the stored settings", () => {
    mocks.event = { status: "error", lastError: "invalid_token" };
    const root = mount();
    expect(latest().settings).toMatchObject({ status: "error", lastError: "invalid_token" });
    expect(latest().canConfigure).toBe(true);
    act(() => root.unmount());
  });

  it("shows the saved settings after a change and names the rejected id on failure", async () => {
    const root = mount();
    mocks.command.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        enabled: true,
        tokenConfigured: true,
        allowedUserIds: ["1"],
        status: "running",
      },
    });
    await act(async () => {
      expect(await latest().configure({ enabled: true })).toEqual({ ok: true });
    });
    expect(latest().settings).toMatchObject({ enabled: true, status: "running" });
    mocks.command.mockResolvedValueOnce({ _tag: "Failure" });
    mocks.failure = new TelegramChannelSettingsError({ reason: "invalid_user_id", detail: "x" });
    expect(await latest().configure({ allowedUserIds: ["x"] })).toEqual({
      ok: false,
      message: "x: A Telegram user id is a number, such as 123456789.",
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
