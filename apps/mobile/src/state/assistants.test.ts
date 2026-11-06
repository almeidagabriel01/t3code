import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({ mocks: { query: vi.fn() } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: vi.fn() }));
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const { Layer } = await import("effect");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});
vi.mock("./session", () => ({ environmentSession: {}, sessionHasScope: () => false }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./query", () => ({ useEnvironmentQuery: mocks.query }));

import { useAtomValue } from "@effect/atom-react";

import { useAtomCommand } from "./use-atom-command";
import { useAssistantSandbox, useAssistantSandboxActions, useAssistantSpend } from "./assistants";

describe("useAssistantSpend", () => {
  it("stays idle without an assistant and queries its spend otherwise", () => {
    useAssistantSpend("hub" as never, null);
    expect(mocks.query).toHaveBeenLastCalledWith(null);
    useAssistantSpend("hub" as never, "a1" as never);
    expect(mocks.query.mock.calls.at(-1)?.[0]).not.toBeNull();
  });
});

describe("sandbox hooks", () => {
  it("reads the sandbox status atom and answers null before the first report", () => {
    vi.mocked(useAtomValue).mockReturnValueOnce({ state: "running" });
    expect(useAssistantSandbox("hub" as never)).toEqual({ state: "running" });
  });

  it("settles each action into a reply and sends the remove choice", async () => {
    const start = vi.fn().mockResolvedValue({ _tag: "Success", value: { state: "running" } });
    const stop = vi
      .fn()
      .mockResolvedValue({ _tag: "Failure", cause: Cause.fail({ message: "Docker said no" }) });
    const remove = vi.fn().mockResolvedValue({ _tag: "Success", value: { state: "not_created" } });
    vi.mocked(useAtomCommand)
      .mockReturnValueOnce(start as never)
      .mockReturnValueOnce(stop as never)
      .mockReturnValueOnce(remove as never);
    vi.mocked(useAtomValue).mockReturnValueOnce(true);
    const actions = useAssistantSandboxActions("hub" as never);
    expect(actions.canAct).toBe(true);
    expect(await actions.start()).toEqual({ ok: true, value: { state: "running" } });
    expect(start).toHaveBeenCalledWith({ environmentId: "hub", input: {} });
    expect(await actions.stop()).toEqual({ ok: false, message: "Docker said no" });
    await actions.remove(true);
    expect(remove).toHaveBeenCalledWith({ environmentId: "hub", input: { deleteVolumes: true } });
  });
});
