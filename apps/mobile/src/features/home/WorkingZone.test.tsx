import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { rows: [] as unknown[], select: vi.fn() },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    onPress?: () => void;
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={() => props.onPress?.()}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../state/assistants", () => ({ useWorkingRows: () => mocks.rows }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.select,
}));

import { WorkingZone } from "./WorkingZone";

const row = (key: string, threadId: string | null, title: string, line: string) => ({
  item: {
    key,
    shell: null,
    consumer: {
      kind: threadId === null ? "groupMember" : "assistant",
      environmentId: "vps",
      threadId,
      assistantId: "ada",
      groupId: "dev",
      parentThreadId: null,
      providerInstanceId: null,
    },
  },
  title,
  line,
});

describe("WorkingZone", () => {
  it("opens a row's thread, or its group when the thread has not arrived", async () => {
    mocks.rows = [
      row("vps:assistant:ada:1", "assistant:ada:1", "Ada", "Ada · VPS"),
      row("member:vps:dev:bo", null, "Group task", "Bo · Backend · VPS"),
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<WorkingZone gutter={8} />));
    expect(container.textContent).toContain("Working2");
    expect(container.textContent).toContain("Bo · Backend · VPS");

    const buttons = [...container.querySelectorAll("button")];
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    expect(mocks.select.mock.calls).toEqual([
      [{ name: "Thread", params: { environmentId: "vps", threadId: "assistant:ada:1" } }],
      [{ name: "AssistantGroupChat", params: { environmentId: "vps", teamId: "dev" } }],
    ]);
    act(() => root.unmount());
  });

  it("draws nothing while nobody works", async () => {
    mocks.rows = [];
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<WorkingZone gutter={8} />));
    expect(container.textContent).toBe("");
    act(() => root.unmount());
  });
});
