import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    owner: null as null | { assistant: { id: string; name: string; threadId: string | null } },
    shell: null as null | Record<string, unknown>,
    open: vi.fn(),
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
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../state/assistants", () => ({ useTaskAssistant: () => mocks.owner }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => mocks.shell }));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { mood?: string }) => <i>{`face:${props.mood}`}</i>,
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({ openConversation: mocks.open }),
}));

import { AssistantTaskChip } from "./AssistantTaskChip";

const jarvis = { id: "jarvis", name: "Jarvis", threadId: "assistant:jarvis:1" };
const failedShell = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  pendingGuestMessageCount: 0,
  queuedMessageCount: 0,
  blockedOnThreadWait: false,
  latestRun: null,
  runtime: { status: "failed" },
  source: { latestVisibleMessage: null },
};

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(() =>
    root.render(<AssistantTaskChip environmentId={"env" as never} threadId={"t1" as never} />),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.owner = null;
  mocks.shell = null;
  mocks.open.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("AssistantTaskChip", () => {
  it("renders nothing for a thread no assistant launched", () => {
    render();
    expect(container.textContent).toBe("");
  });

  it("wears the assistant's face in the task's mood and opens the assistant on tap", async () => {
    mocks.owner = { assistant: jarvis };
    render();
    expect(container.textContent).toContain("Task of Jarvis, running");
    expect(container.textContent).toContain("face:working");
    await act(async () => container.querySelector("button")?.click());
    expect(mocks.open).toHaveBeenCalledWith(jarvis);

    mocks.shell = failedShell;
    render();
    expect(container.textContent).toContain("Task of Jarvis, failed");
    expect(container.textContent).toContain("face:failed");
  });
});
