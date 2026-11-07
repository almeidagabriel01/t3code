import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    open: vi.fn(),
    active: [] as unknown[],
    mood: "idle" as "idle" | "needs",
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
  assistantGroupThreadsOf: () => [],
  assistantGroupOwnerKey: () => undefined,
  assistantPresence: () =>
    mocks.mood === "needs"
      ? { mood: "needs", detail: "Needs your approval", since: null }
      : { mood: "idle", detail: "Idle", since: null },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; className?: string }) => (
    <span className={props.className}>{props.children}</span>
  ),
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: mocks.active }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({}),
  useQuietThreadShells: () => [],
}));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { mood: string }) => <i>{`av:${props.mood}`}</i>,
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({ openConversation: mocks.open }),
}));

import { ProjectAssistantRows } from "./ProjectAssistantRows";

const entry = (id: string, extra: object = {}) => ({
  environmentId: "hub",
  assistant: { id, name: id, threadId: `t-${id}`, scope: "project", projectId: "p1", ...extra },
});

let root: Root;
let container: HTMLDivElement;
const render = (sidebar = false) =>
  act(() =>
    root.render(
      <ProjectAssistantRows
        members={[{ environmentId: "hub", projectId: "p1" }]}
        gutter={4}
        sidebar={sidebar}
      />,
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.open.mockReset();
  mocks.mood = "idle";
  mocks.active = [];
});
afterEach(() => act(() => root.unmount()));

describe("ProjectAssistantRows", () => {
  it("renders nothing when the project has no assistants of its own", () => {
    mocks.active = [
      entry("other", { projectId: "p2" }),
      entry("everywhere", { scope: "all" }),
      { ...entry("remote"), environmentId: "lab" },
    ];
    render();
    expect(container.textContent).toBe("");
  });

  it("lists the project's assistants with their status and opens their conversation", async () => {
    mocks.active = [
      entry("scout"),
      entry("loose", { threadId: null }),
      entry("everywhere", { scope: "all" }),
    ];
    mocks.mood = "needs";
    render(true);
    expect(container.textContent).toContain("av:needs");
    expect(container.textContent).toContain("Needs your approval");
    expect(container.textContent).not.toContain("everywhere");
    const rows = container.querySelectorAll("button");
    expect(rows).toHaveLength(2);
    await act(async () => rows[0]!.click());
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "scout" }));
    expect(rows[1]!.disabled).toBe(true);
    render(false);
    expect(container.textContent).toContain("scout");
  });
});
