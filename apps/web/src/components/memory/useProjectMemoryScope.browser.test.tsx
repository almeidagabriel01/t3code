import type { EnvironmentId, MemorySpaceId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

type Result = { _tag: "Success"; value: unknown } | { _tag: "Failure" };

const mocks = vi.hoisted(() => ({
  permissions: { sync: true, bind: true },
  sync: null as unknown as Result,
  binding: null as unknown as Result | null,
  bindingCalls: [] as unknown[],
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: string) =>
    atom === "sync" ? mocks.permissions.sync : mocks.permissions.bind,
}));
vi.mock("../../state/memory", () => ({
  memoryEnvironment: {
    syncStatus: { id: "sync", permissionAtom: () => "sync" },
    projectBindingGet: { id: "bind", permissionAtom: () => "bind" },
  },
}));
const getSync = async () => mocks.sync;
const getBinding = (input: unknown) => {
  mocks.bindingCalls.push(input);
  // A binding left null never answers, so the scope stays loading.
  return mocks.binding === null ? new Promise<Result>(() => {}) : Promise.resolve(mocks.binding);
};
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) => (command.id === "sync" ? getSync : getBinding),
}));
// Stable like the real entity store, so the lookup does not rerun on every render.
const PROJECTS = vi.hoisted(() => [
  {
    id: "with-repo",
    environmentId: "env",
    repositoryIdentity: { canonicalKey: "github.com/acme/app" },
  },
  { id: "no-repo", environmentId: "env", repositoryIdentity: null },
]);
vi.mock("../../state/entities", () => ({ useProjects: () => PROJECTS }));

import { useMemorySpace, useProjectMemoryScope } from "./useProjectMemoryScope";

const environmentId = "env" as EnvironmentId;
const space = "space-1" as MemorySpaceId;

function Probe(props: { readonly projectId: string | null; readonly enabled?: boolean }) {
  const resolvedSpace = useMemorySpace(environmentId, props.enabled ?? true);
  const scope = useProjectMemoryScope(
    environmentId,
    props.projectId as ProjectId | null,
    resolvedSpace,
  );
  return <output>{JSON.stringify({ space: resolvedSpace, scope })}</output>;
}

function setup(over: Partial<typeof mocks> = {}) {
  mocks.permissions = { sync: true, bind: true };
  mocks.sync = { _tag: "Success", value: { state: "enabled", memorySpaceId: space } };
  mocks.binding = { _tag: "Success", value: { projectKey: null, repositoryKey: null } };
  mocks.bindingCalls = [];
  Object.assign(mocks, over);
}

const read = (screen: Awaited<ReturnType<typeof render>>) =>
  JSON.parse(screen.container.querySelector("output")!.textContent!);

it.each([
  {
    name: "uses the project's explicit shared key",
    projectId: "no-repo",
    over: {
      binding: {
        _tag: "Success",
        value: { projectKey: { kind: "explicit", key: "k" }, repositoryKey: null },
      },
    },
    scope: {
      status: "ready",
      scope: { kind: "project", projectKey: { kind: "explicit", key: "k" } },
    },
  },
  {
    name: "falls back to the repository it lives in",
    projectId: "with-repo",
    over: {},
    scope: {
      status: "ready",
      scope: { kind: "project", projectKey: expect.objectContaining({ kind: "repository" }) },
    },
  },
  {
    name: "has no memory without a key or a repository",
    projectId: "no-repo",
    over: {},
    scope: { status: "no-key" },
  },
  {
    name: "reports a failed lookup",
    projectId: "no-repo",
    over: { binding: { _tag: "Failure" } },
    scope: { status: "failed" },
  },
  {
    name: "needs write access for the lookup",
    projectId: "no-repo",
    over: { permissions: { sync: true, bind: false } },
    scope: { status: "no-permission" },
  },
  {
    name: "stays loading until the lookup answers",
    projectId: "no-repo",
    over: { binding: null },
    scope: { status: "loading" },
  },
  { name: "has no scope without a project", projectId: null, over: {}, scope: null },
] as const)("$name", async ({ projectId, over, scope }) => {
  setup(over as Partial<typeof mocks>);
  await using screen = await render(<Probe projectId={projectId} />, { router: false });
  await vi.waitFor(() => expect(read(screen)).toEqual({ space, scope }));
});

it("asks for nothing while disabled or without sync permission", async () => {
  setup({ permissions: { sync: false, bind: true } });
  await using screen = await render(<Probe projectId="with-repo" />, { router: false });
  await vi.waitFor(() =>
    expect(read(screen)).toEqual({ space: null, scope: { status: "loading" } }),
  );
  expect(mocks.bindingCalls).toEqual([]);
});
