import { RegistryProvider } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

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

function Probe({ environmentId }: { environmentId: EnvironmentId | null }) {
  return <output>{JSON.stringify(useKeepAwakeStatus(environmentId))}</output>;
}

it.each([
  { name: "a server that reports it", id: "new", shown: '{"supported":true,"active":true}' },
  { name: "an older server", id: "old", shown: "null" },
  { name: "no environment", id: null, shown: "null" },
])("reports the host status for $name", async ({ id, shown }) => {
  await using screen = await render(
    <RegistryProvider>
      <Probe environmentId={id as EnvironmentId | null} />
    </RegistryProvider>,
    { router: false }, // no routes involved
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent(shown);
});
