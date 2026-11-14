import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    owner: null as null | { assistant: { id: string; name: string; threadId: string | null } },
    shell: null as null | Record<string, unknown>,
    task: null as null | { dismissedAt: string | null },
    open: vi.fn(),
    dismiss: vi.fn(),
    restore: vi.fn(),
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
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: Array<{ id: string; title: string; attributes?: { disabled?: boolean } }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`menu:${action.title}`}
          disabled={action.attributes?.disabled}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </>
  ),
}));
vi.mock("../../state/assistants", () => ({
  useTaskAssistant: () => mocks.owner,
  useAssistantTask: () => mocks.task,
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => mocks.shell }));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { mood?: string }) => <i>{`face:${props.mood}`}</i>,
}));
vi.mock("./useUsageLimitLabel", () => ({
  useUsageLimitLabel: () => (resetAt: string | null | undefined) =>
    resetAt == null ? null : `Limit until <${resetAt}>`,
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({
    canAct: true,
    openConversation: mocks.open,
    dismissTask: mocks.dismiss,
    restoreTask: mocks.restore,
  }),
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

const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

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
  mocks.task = { dismissedAt: null };
  for (const fn of [mocks.open, mocks.dismiss, mocks.restore]) fn.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("AssistantTaskChip", () => {
  it("renders nothing for a thread no assistant launched", () => {
    render();
    expect(container.textContent).toBe("");
  });

  it("wears the assistant's face in the task's mood and opens the assistant from its menu", async () => {
    mocks.owner = { assistant: jarvis };
    render();
    expect(container.textContent).toContain("Task of Jarvis, running");
    expect(container.textContent).toContain("face:working");
    await act(async () => byLabel("menu:Open Jarvis")?.click());
    expect(mocks.open).toHaveBeenCalledWith(jarvis);

    mocks.shell = failedShell;
    render();
    expect(container.textContent).toContain("Task of Jarvis, failed");
    expect(container.textContent).toContain("face:failed");

    mocks.shell = {
      ...failedShell,
      runtime: { status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: "2099-01-01" },
    };
    render();
    expect(container.textContent).toContain("Task of Jarvis, limit until <2099-01-01>");
  });

  it("dismisses a finished task, refuses a running one, and restores a dismissed one", async () => {
    mocks.owner = { assistant: jarvis };
    render();
    expect(byLabel("menu:Dismiss task")?.disabled).toBe(true);

    mocks.shell = failedShell;
    render();
    await act(async () => byLabel("menu:Dismiss task")?.click());
    expect(mocks.dismiss).toHaveBeenCalledWith("t1");

    mocks.task = { dismissedAt: "2026-11-06T00:00:00.000Z" };
    render();
    expect(byLabel("menu:Dismiss task")).toBeNull();
    await act(async () => byLabel("menu:Restore task")?.click());
    expect(mocks.restore).toHaveBeenCalledWith("t1");
  });
});
