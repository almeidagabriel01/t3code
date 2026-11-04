import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  alert: vi.fn(),
  scope: true,
  organization: true,
  operable: new Set<string>(["hub"]),
}));
const project = (id: string, environmentId: string) => ({ environmentId, id, title: `T${id}` });
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [project("a", "hub"), project("b", "hub")],
  useServerConfigs: () =>
    new Map([
      ["hub", { environment: { capabilities: { projectOrganization: mocks.organization } } }],
    ]),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { update: {} } }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => mocks.scope,
  useEnvironmentsWithScope: () => mocks.operable,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));

import * as Cause from "effect/Cause";
import { useProjectOrganize } from "./useProjectOrganize";

let api: ReturnType<typeof useProjectOrganize>;
function Probe() {
  api = useProjectOrganize();
  return null;
}
const refs = [
  { environmentId: "hub", projectId: "a" },
  { environmentId: "hub", projectId: "b" },
] as never;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.alert.mockReset();
  mocks.scope = true;
  mocks.organization = true;
  mocks.operable = new Set(["hub"]);
  await act(() => createRoot(window.document.createElement("div")).render(<Probe />));
});

describe("useProjectOrganize", () => {
  it("archives every checkout of a scope", async () => {
    await api.setScopeArchived(refs, true);
    expect(mocks.update.mock.calls.map(([call]) => call)).toEqual([
      { environmentId: "hub", input: { projectId: "a", archived: true } },
      { environmentId: "hub", input: { projectId: "b", archived: true } },
    ]);
  });

  it("stops at the first failure and reports it unless interrupted", async () => {
    mocks.update.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("boom")) });
    await api.setScopeArchived(refs, false);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.alert).toHaveBeenCalledWith('Failed to update "Ta"', "boom");

    mocks.alert.mockReset();
    mocks.update.mockResolvedValue({ _tag: "Failure", cause: Cause.interrupt() });
    await api.setScopeArchived(refs, false);
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("refuses without operate scope", async () => {
    mocks.scope = false;
    await api.setScopeArchived(refs, true);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "operable and supported", operable: ["hub"], organization: true, expected: true },
    { name: "read-only", operable: [], organization: true, expected: false },
    { name: "older server", operable: ["hub"], organization: false, expected: false },
  ])("canOrganizeRefs: $name", async ({ operable, organization, expected }) => {
    mocks.operable = new Set(operable);
    mocks.organization = organization;
    await act(() => createRoot(window.document.createElement("div")).render(<Probe />));
    expect(api.canOrganizeRefs(refs)).toBe(expected);
    expect(api.canOrganizeRefs([{ environmentId: "hub", projectId: "gone" }] as never)).toBe(false);
  });
});
