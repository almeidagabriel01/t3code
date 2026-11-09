import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AssistantTaskBadge } from "./AssistantTaskBadge";

const state = vi.hoisted(() => ({
  owner: null as null | { assistant: { id: string; name: string; threadId: string | null } },
  shell: null as null | Record<string, unknown>,
  openConversation: vi.fn(),
}));

vi.mock("../../state/assistants", () => ({ useTaskAssistant: () => state.owner }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => state.shell }));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({ openConversation: state.openConversation }),
}));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { mood?: string }) => <i>{`face:${props.mood}`}</i>,
}));

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("task-1");
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

function setup(owner: typeof state.owner, shell: typeof state.shell = null) {
  state.owner = owner;
  state.shell = shell;
  state.openConversation.mockReset();
}

describe("AssistantTaskBadge", () => {
  it("renders nothing for a thread no assistant launched", async () => {
    setup(null);
    await using screen = await render(
      <AssistantTaskBadge environmentId={environmentId} threadId={threadId} />,
    );
    expect(screen.container.textContent).toBe("");
  });

  it("shows the assistant's face in the task's mood and opens the assistant on click", async () => {
    setup({ assistant: jarvis });
    await using screen = await render(
      <AssistantTaskBadge environmentId={environmentId} threadId={threadId} />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Task of Jarvis, running" }))
      .toBeVisible();
    expect(screen.container.textContent).toContain("face:working");
    await userEvent.click(screen.getByRole("button", { name: "Task of Jarvis, running" }));
    expect(state.openConversation).toHaveBeenCalledWith(jarvis);

    state.shell = failedShell;
    await screen.rerender(<AssistantTaskBadge environmentId={environmentId} threadId={threadId} />);
    await expect
      .element(screen.getByRole("button", { name: "Task of Jarvis, failed" }))
      .toBeVisible();
  });
});
