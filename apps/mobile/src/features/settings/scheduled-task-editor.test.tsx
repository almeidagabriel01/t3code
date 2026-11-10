import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    targets: [] as { environmentId: string; label: string }[],
    selectedProjects: null as null | { environmentId: string; id: string }[],
  },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "hub", id: "p1", pinnedAt: "2026-01-01", archivedAt: null },
    { environmentId: "hub", id: "p2", pinnedAt: null, archivedAt: null },
    { environmentId: "lab", id: "q1", pinnedAt: null, archivedAt: null },
  ],
  useServerConfigs: () => new Map(),
  useThreadShell: () => null,
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/threads", () => ({ threadFamilies: {} }));
vi.mock("./scheduled-task-editor-state", () => ({
  scheduledTaskEditorHasChanges: () => false,
  scheduledTaskEditorSessionAtom: {},
  startScheduledTaskEditor: vi.fn(),
  updateScheduledTaskEditor: vi.fn(),
  readScheduledTaskEditor: vi.fn(),
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: mocks.targets,
    selectedProjects: mocks.selectedProjects,
  }),
}));

import { useScheduledTaskEditor } from "./scheduled-task-editor";

let editor: ReturnType<typeof useScheduledTaskEditor>;
const setEditor = (next: typeof editor) => {
  editor = next;
};
function Probe(props: { readonly sink: typeof setEditor }) {
  props.sink(useScheduledTaskEditor());
  return null;
}

let unmount = () => {};
const render = () => {
  const root = createRoot(document.createElement("div"));
  unmount = () => act(() => root.unmount());
  act(() => root.render(<Probe sink={setEditor} />));
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.targets = [
    { environmentId: "hub", label: "Hub" },
    { environmentId: "lab", label: "Lab" },
  ];
  mocks.selectedProjects = null;
});
afterEach(() => unmount());

const projectOf = (environmentId: string) =>
  (editor.draftForEnvironment(environmentId as never) as { projectId: string | null }).projectId;

describe("new scheduled task defaults", () => {
  it("prefers a selected project over the pinned one, in each environment", () => {
    mocks.selectedProjects = [
      { environmentId: "lab", id: "q1" },
      { environmentId: "hub", id: "p2" },
    ];
    render();

    expect(editor.editor?.environmentId).toBe("hub");
    expect(projectOf("hub")).toBe("p2");
    expect(projectOf("lab")).toBe("q1");
  });

  it("only offers environments that have a selected project", () => {
    mocks.selectedProjects = [{ environmentId: "lab", id: "q1" }];
    render();
    expect(editor.editor?.environmentId).toBe("lab");
  });

  it("falls back to the pinned project when nothing is selected", () => {
    render();
    expect(projectOf("hub")).toBe("p1");
  });
});
