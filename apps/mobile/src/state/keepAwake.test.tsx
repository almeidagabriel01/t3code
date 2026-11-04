import { RegistryProvider } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/keepAwake", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const reported = Atom.make(AsyncResult.success({ supported: true, active: true }));
  return { createKeepAwakeEnvironmentAtoms: () => ({ status: () => reported }) };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentServerConfigsAtom: Atom.make(
      new Map([
        ["new", { environment: { capabilities: { keepAwake: true } } }],
        ["old", { environment: { capabilities: {} } }],
      ]),
    ),
  };
});

import { useKeepAwakeStatus } from "./keepAwake";

function Probe({ environmentId }: { environmentId: EnvironmentId }) {
  return <output>{JSON.stringify(useKeepAwakeStatus(environmentId))}</output>;
}

it.each([
  { name: "a server that reports it", id: "new", shown: '{"supported":true,"active":true}' },
  { name: "an older server", id: "old", shown: "null" },
])("reports the host status for $name", async ({ id, shown }) => {
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
  await act(async () => root.unmount());
});
