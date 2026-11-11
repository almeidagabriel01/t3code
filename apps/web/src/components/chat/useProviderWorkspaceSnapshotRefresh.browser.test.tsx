import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useProviderWorkspaceSnapshotRefresh } from "./useProviderWorkspaceSnapshotRefresh";

const mocks = vi.hoisted(() => ({ scratchRoot: null as string | null }));

vi.mock("../../state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../../state/server")>()),
    serverEnvironment: {
      configValueAtom: () =>
        Atom.make(mocks.scratchRoot === null ? {} : { scratchWorkspaceRoot: mocks.scratchRoot }),
    },
  };
});
vi.mock("@t3tools/client-runtime/providerSkills", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const scans = new Map<string, unknown>();
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/providerSkills")>()),
    isProviderWorkspaceSnapshotScanning: (state: unknown) => state !== undefined,
    // Stands in for the scan of one cwd; the real family is covered in client-runtime.
    createProviderWorkspaceSnapshotRefreshAtomFamily: () => (target: { cwd: string }) => {
      if (!scans.has(target.cwd)) scans.set(target.cwd, Atom.make({ cwd: target.cwd }));
      return scans.get(target.cwd);
    },
  };
});

function Probe(props: { gitCwd: string | null }) {
  const { cwd, scanning } = useProviderWorkspaceSnapshotRefresh({
    environmentId: EnvironmentId.make("env"),
    gitCwd: props.gitCwd,
    instanceId: ProviderInstanceId.make("claudeAgent"),
  });
  return <output>{`${cwd ?? "no cwd"}: ${scanning ? "scanning" : "idle"}`}</output>;
}

it.each([
  { name: "the project's cwd", gitCwd: "/repo", scratchRoot: "/scratch", shown: "/repo: scanning" },
  // The config carries only names, so a draft with no project still needs a catalog to show.
  {
    name: "the scratch folder without a project",
    gitCwd: null,
    scratchRoot: "/scratch",
    shown: "/scratch: scanning",
  },
  { name: "nothing without either", gitCwd: null, scratchRoot: null, shown: "no cwd: idle" },
])("loads the catalog for $name", async ({ gitCwd, scratchRoot, shown }) => {
  mocks.scratchRoot = scratchRoot;
  await using _screen = await render(<Probe gitCwd={gitCwd} />, { router: false }); // a bare hook probe
  await expect.element(page.getByText(shown)).toBeVisible();
});
