import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    can: true,
    projects: [{ environmentId: "env", id: "p1", repositoryIdentity: null }] as unknown[],
    // Stable like the app's compiled hooks: a new function each render would re-run the effects.
    getSync: vi.fn(),
    getBinding: vi.fn(),
  },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.can }));
vi.mock("react-native", () => ({ Keyboard: { dismiss: vi.fn() } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: vi.fn(), alert: vi.fn() }));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../state/memory", () => ({
  memoryEnvironment: {
    syncStatus: { label: "sync", permissionAtom: () => ({}) },
    projectBindingGet: { label: "binding", permissionAtom: () => ({}) },
    forget: { label: "forget" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "sync" ? mocks.getSync : mocks.getBinding,
}));

import { useMemorySpace, useProjectMemoryScope } from "./useProjectMemory";

let seen: unknown[] = [];
function Probe(props: { projectId: string | null }) {
  const space = useMemorySpace("env" as never, true);
  seen.push(useProjectMemoryScope("env" as never, props.projectId, space));
  return null;
}

async function mount(projectId: string | null) {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe projectId={projectId} />));
  return { unmount: () => act(() => root.unmount()) };
}

const ready = { _tag: "Success", value: { state: "ready", memorySpaceId: "space-1" } };

afterEach(() => {
  mocks.can = true;
  seen = [];
  vi.clearAllMocks();
});

describe("useProjectMemoryScope", () => {
  it("loads the space, then the project's binding, and resolves to its scope", async () => {
    mocks.getSync.mockResolvedValue(ready);
    mocks.getBinding.mockResolvedValue({
      _tag: "Success",
      value: { projectKey: { kind: "explicit", groupingKey: "alpha" } },
    });
    const view = await mount("p1");
    expect(seen[0]).toEqual({ status: "loading" });
    expect(mocks.getBinding).toHaveBeenCalledWith({
      environmentId: "env",
      input: { memorySpaceId: "space-1", project: { environmentId: "env", projectId: "p1" } },
    });
    expect(seen.at(-1)).toMatchObject({ status: "ready", scope: { kind: "project" } });
    await view.unmount();
  });

  it.each([
    ["a failed lookup", { _tag: "Failure" }, { status: "failed" }],
    [
      "a project with no key",
      { _tag: "Success", value: { projectKey: null } },
      { status: "no-key" },
    ],
  ])("reports %s", async (_name, result, expected) => {
    mocks.getSync.mockResolvedValue(ready);
    mocks.getBinding.mockResolvedValue(result);
    const view = await mount("p1");
    expect(seen.at(-1)).toEqual(expected);
    await view.unmount();
  });

  it("needs write permission, and is null without a project", async () => {
    mocks.can = false;
    const denied = await mount("p1");
    expect(seen.at(-1)).toEqual({ status: "no-permission" });
    expect(mocks.getSync).not.toHaveBeenCalled();
    await denied.unmount();
    mocks.can = true;
    mocks.getSync.mockResolvedValue(ready);
    const none = await mount(null);
    expect(seen.at(-1)).toBeNull();
    expect(mocks.getBinding).not.toHaveBeenCalled();
    await none.unmount();
  });
});
