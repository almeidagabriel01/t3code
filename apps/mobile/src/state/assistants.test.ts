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

import { useAssistantSpend } from "./assistants";

describe("useAssistantSpend", () => {
  it("stays idle without an assistant and queries its spend otherwise", () => {
    useAssistantSpend("hub" as never, null);
    expect(mocks.query).toHaveBeenLastCalledWith(null);
    useAssistantSpend("hub" as never, "a1" as never);
    expect(mocks.query.mock.calls.at(-1)?.[0]).not.toBeNull();
  });
});
