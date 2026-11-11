import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    environmentId: "env",
    current: { projectIds: ["all"], modelSelection: null },
    assistant: null,
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  useEnvironmentServerConfig: () => null,
  useThreadShell: () => null,
}));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  modelWithEffortLabel: () => "model",
}));
vi.mock("../settings/scheduledTaskDraft", () => ({ scheduledTaskDefaultModel: () => null }));
vi.mock("./assistantDraft", () => ({ assistantEditorAtom: "editor" }));

import { assistantProjectName, useAssistantEditor } from "./useAssistantEditor";

const project = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  environmentId: "env",
  workspaceRoot: `/work/${id}`,
  ...extra,
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it("names the assistants home project All projects and any other project by its title", () => {
  expect(
    assistantProjectName(project("home", "Assistants", { managedRole: "assistants" }) as never),
  ).toBe("All projects");
  expect(assistantProjectName(project("scratch", "Scratch", { isScratch: true }) as never)).toBe(
    "All projects",
  );
  expect(assistantProjectName(project("p", "Billing") as never)).toBe("Billing");
});

it("keeps the assistants home project out of the picker rows", () => {
  mocks.projects = [
    project("home", "Assistants", { managedRole: "assistants" }),
    project("p", "Billing"),
    { ...project("other-env", "Elsewhere"), environmentId: "other" },
  ];
  let rows: ReadonlyArray<{ label: string }> = [];
  const Probe = () => {
    rows = useAssistantEditor().pickerRows as unknown as ReadonlyArray<{ label: string }>;
    return null;
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  expect(rows.map((row) => row.label)).toContain("Billing");
  expect(rows.map((row) => row.label)).not.toContain("Assistants");
  expect(rows.map((row) => row.label)).not.toContain("Elsewhere");
});
