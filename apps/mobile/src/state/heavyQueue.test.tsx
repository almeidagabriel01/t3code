import { RegistryProvider } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/heavyQueue", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const queued = Atom.make(AsyncResult.success({ entries: [{ id: "a" }] }));
  const waiting = Atom.make(AsyncResult.initial());
  return {
    createHeavyQueueEnvironmentAtoms: () => ({
      state: ({ environmentId }: { environmentId: string }) =>
        environmentId === "new" ? queued : waiting,
    }),
  };
});

import { useHeavyQueueEntries } from "./heavyQueue";

function Probe({ environmentId }: { environmentId: EnvironmentId }) {
  return <output>{useHeavyQueueEntries(environmentId).length}</output>;
}

it.each([
  { name: "a reported queue", id: "new", shown: "1" },
  { name: "a loading or rejected subscription", id: "old", shown: "0" },
])("lists entries for $name", async ({ id, shown }) => {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <RegistryProvider>
        <Probe environmentId={id as EnvironmentId} />
      </RegistryProvider>,
    );
  });
  expect(host.textContent).toBe(shown);
  await act(() => root.unmount());
});
