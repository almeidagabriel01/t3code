import { taskEventHeadline } from "@t3tools/shared/assistantTaskEvents";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { shellTitle: null as string | null, openLinkedThread: vi.fn() },
}));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: { onPress?: () => void; children?: ReactNode }) => (
    <button onClick={props.onPress}>{props.children}</button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../state/entities", () => ({
  useQuietThreadShell: () => (mocks.shellTitle === null ? null : { title: mocks.shellTitle }),
}));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => mocks.openLinkedThread }));

const { ThreadTaskEventRow } = await import("./ThreadTaskEventRow");
const { taskEventActivity } = await import("@t3tools/client-runtime/assistantTasks");

const taskThread = "mcp:launch:task" as ThreadId;
const environmentId = "env-1" as EnvironmentId;

async function mount(text: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const message = { id: "assistant-task:r1", text, senderThreadId: taskThread };
  const activity = taskEventActivity(message)!;
  const container = window.document.createElement("div");
  await act(async () =>
    createRoot(container).render(
      <ThreadTaskEventRow environmentId={environmentId} message={message} activity={activity} />,
    ),
  );
  return container;
}

describe("ThreadTaskEventRow", () => {
  beforeEach(() => {
    mocks.shellTitle = null;
    mocks.openLinkedThread.mockReset();
  });

  it("shows the headline's title and opens the task thread on press", async () => {
    const view = await mount(
      taskEventHeadline({ title: "Add retry", threadId: taskThread, status: "failed" }),
    );
    expect(view.textContent).toContain("Add retry");
    expect(view.textContent).toContain("· Failed");
    await act(async () => view.querySelector("button")!.click());
    expect(mocks.openLinkedThread).toHaveBeenCalledWith({
      environmentId: "env-1",
      threadId: taskThread,
    });
  });

  it("uses the live task thread title when the headline carries none", async () => {
    mocks.shellTitle = "  Live title ";
    const view = await mount("not written by T3");
    expect(view.textContent).toContain("Live title");
  });
});
