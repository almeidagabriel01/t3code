import { RegistryProvider } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

vi.mock("@t3tools/client-runtime/state/heavyQueue", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const reported = Atom.make(AsyncResult.success({ entries: [{ id: "a" }, { id: "b" }] }));
  const failed = Atom.make(AsyncResult.fail("older server"));
  return {
    createHeavyQueueEnvironmentAtoms: () => ({
      state: ({ environmentId }: { environmentId: string }) =>
        environmentId === "old" ? failed : reported,
    }),
  };
});

import { useHeavyQueue } from "./heavyQueue";

function Probe({ environmentId }: { environmentId: EnvironmentId | null }) {
  return <output>{useHeavyQueue(environmentId).entries.length}</output>;
}

it.each([
  { name: "a reporting server", id: "new", count: "2" },
  { name: "an older server whose subscription fails", id: "old", count: "0" },
  { name: "no environment", id: null, count: "0" },
])("lists the queue for $name", async ({ id, count }) => {
  await using screen = await render(
    <RegistryProvider>
      <Probe environmentId={id as EnvironmentId | null} />
    </RegistryProvider>,
    { router: false }, // no routes involved
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent(count);
});
