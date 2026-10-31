import type { DecisionEntry } from "@t3tools/client-runtime/state/decisions";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { entries: { open: [] as unknown[], settled: [] } },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.entries }));
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

import { useThreadOpenDecisions } from "./decisions";

const entry = (id: string, environmentId: string, fromThreadId: string, approval?: string) =>
  ({
    environmentId,
    decision: { id, fromThreadId, approvalRequestId: approval },
  }) as unknown as DecisionEntry;

describe("useThreadOpenDecisions", () => {
  it("keeps the thread's own decisions and leaves out provider approvals", () => {
    mocks.entries.open = [
      entry("a", "hub", "t1"),
      entry("b", "hub", "t1", "approval-1"),
      entry("c", "hub", "t2"),
      entry("d", "other", "t1"),
    ];
    const ids = useThreadOpenDecisions("hub" as never, "t1" as never).map(
      (item) => item.decision.id,
    );
    expect(ids).toEqual(["a"]);
  });
});
