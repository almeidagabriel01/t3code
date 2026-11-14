import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  editor: null as unknown,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.editor }));
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
  mocks.editor = {
    environmentId: "env",
    current: { projectIds: ["all"], modelSelection: null },
    assistant: null,
  };
});

const probe = () => {
  let state: ReturnType<typeof useAssistantEditor> | null = null;
  const Probe = () => {
    state = useAssistantEditor();
    return null;
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return state!;
};

it.each([
  ["an older server", undefined, undefined, false, null],
  ["the stored default", "stored", undefined, true, "stored"],
  ["a picked default", "stored", "picked", true, "picked"],
  ["a cleared default", "stored", null, true, null],
  ["no default yet", null, undefined, true, null],
] as const)(
  "reads the assistant's default model from %s",
  (_name, stored, touched, shown, value) => {
    const model = (name: string | null) =>
      name === null ? null : { instanceId: "codex", model: name };
    mocks.editor = {
      environmentId: "env",
      current: {
        projectIds: ["all"],
        modelSelection: null,
        defaultModelSelection: touched === undefined ? undefined : model(touched),
      },
      assistant: {
        projectId: null,
        threadId: null,
        ...(stored === undefined ? {} : { defaultModelSelection: model(stored) }),
      },
    };
    const state = probe();
    expect(state.supportsDefaultModel).toBe(shown);
    expect(state.defaultModelSelection).toEqual(value === null ? null : model(value));
  },
);

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
