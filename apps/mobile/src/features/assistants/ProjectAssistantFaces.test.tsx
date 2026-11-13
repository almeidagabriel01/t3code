import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    select: vi.fn(),
    active: [] as Array<{
      environmentId: string;
      assistant: {
        id: string;
        name: string;
        threadId: string | null;
        scope: string;
        projectId: string;
      };
    }>,
    sites: [] as Array<Record<string, string>>,
  },
}));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/client-runtime/assistantRobot", () => ({
  assistantFace: () => "idle",
  assistantPresenceOf: () => ({ mood: "idle", detail: "Idle", since: null }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; testID?: string }) => (
    <span data-testid={props.testID}>{props.children}</span>
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: Array<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`menu:${action.title}`}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </>
  ),
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: mocks.active }),
  useAssistantLiveWork: () => ({ sites: mocks.sites }),
}));
vi.mock("../../state/entities", () => ({ useQuietThreadShells: () => [] }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.select,
}));
vi.mock("./assistantPresentation", () => ({
  AssistantCluster: (props: {
    faces: ReadonlyArray<{ key: string; assistant: { name: string }; mood?: string }>;
  }) => (
    <b data-testid="cluster">
      {props.faces.map((face) => (
        <i key={face.key} data-mood={face.mood}>{`av:${face.assistant.name}`}</i>
      ))}
    </b>
  ),
}));

import { ProjectAssistantFaces } from "./ProjectAssistantFaces";

const bot = (name: string, extra: object = {}) => ({
  environmentId: "hub",
  assistant: {
    id: `id-${name}`,
    name,
    threadId: `t-${name}`,
    scope: "project",
    projectId: "p1",
    ...extra,
  },
});

function render(entries: typeof mocks.active, sites: typeof mocks.sites = []) {
  mocks.active = entries;
  mocks.sites = sites;
  mocks.select.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <ProjectAssistantFaces
        title="Alpha"
        members={[{ environmentId: "hub", projectId: "p1" }]}
        gutter={4}
      />,
    ),
  );
  return container;
}
const click = (container: HTMLElement, label: string) =>
  act(() => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click());

describe("ProjectAssistantFaces", () => {
  it.each([
    { names: [] },
    { names: ["Atlas"] },
    { names: ["Atlas", "Nova"] },
    { names: ["Atlas", "Nova", "Echo", "Pip", "Rex"] },
  ])("hands every one of $names to one cluster", ({ names }) => {
    const container = render(names.map((name) => bot(name)));
    expect(container.querySelectorAll('[data-testid="cluster"]').length).toBe(
      names.length > 0 ? 1 : 0,
    );
    expect([...container.querySelectorAll("i")].map((face) => face.textContent)).toEqual(
      names.map((name) => `av:${name}`),
    );
    expect(container.textContent?.includes("Alpha")).toBe(names.length > 0);
  });

  it("ignores assistants of other projects and of scope all", () => {
    const container = render([
      bot("Other", { projectId: "p2" }),
      bot("Everywhere", { scope: "all" }),
    ]);
    expect(container.textContent).toBe("");
  });

  it("opens the only assistant's conversation from the labelled cluster", () => {
    const container = render([bot("Atlas")]);
    click(container, "Atlas: assistants in this project");
    expect(mocks.select).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "t-Atlas" },
    });
  });

  it("offers a menu of all assistants when there are several, and opens the picked one", () => {
    const container = render([bot("Atlas"), bot("Nova"), bot("Echo")]);
    expect(
      container.querySelector('[aria-label="Atlas, Nova, Echo: assistants in this project"]'),
    ).not.toBeNull();
    click(container, "menu:Echo");
    expect(mocks.select).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "t-Echo" },
    });
  });

  it("puts an assistant working here first, in its work's mood, and opens that work", () => {
    const site = { environmentId: "hub", assistantId: "id-Echo", face: "waiting" };
    const container = render(
      [bot("Atlas"), bot("Echo", { scope: "all" })],
      [
        { ...site, projectId: "p1", threadId: "task-1" },
        { ...site, projectId: "p9", threadId: "task-9" },
      ],
    );
    const faces = [...container.querySelectorAll("i")];
    expect(faces.map((face) => [face.textContent, face.dataset.mood ?? null])).toEqual([
      ["av:Echo", "waiting"],
      ["av:Atlas", "idle"],
    ]);
    expect(container.querySelector('[aria-label="Echo is working here, Atlas"]')).not.toBeNull();
    click(container, "menu:Echo is working here");
    expect(mocks.select).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "task-1" },
    });
  });

  it("opens the work from the cluster when the only face is a working one", () => {
    const container = render(
      [bot("Echo", { scope: "all" })],
      [
        {
          environmentId: "hub",
          assistantId: "id-Echo",
          projectId: "p1",
          threadId: "task-1",
          face: "working",
        },
      ],
    );
    click(container, "Echo is working here");
    expect(mocks.select).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "task-1" },
    });
  });

  it("disables the cluster for an assistant without a conversation yet", () => {
    const container = render([bot("Atlas", { threadId: null })]);
    expect(container.querySelector<HTMLButtonElement>('[aria-label^="Atlas"]')!.disabled).toBe(
      true,
    );
  });
});
