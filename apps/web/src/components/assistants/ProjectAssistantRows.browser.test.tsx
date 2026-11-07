import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ProjectAssistantRows } from "./ProjectAssistantRows";

const assistant = (
  name: string,
  scope: "all" | "project",
  projectId: string,
  threadId: string | null,
) => ({
  environmentId: "env",
  assistant: {
    id: name,
    name,
    threadId,
    scope,
    projectId,
    avatar: null,
    icon: null,
  },
});

vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: [
      assistant("Revisor", "project", "p1", "assistant:revisor:1"),
      assistant("Novo", "project", "p1", null),
      assistant("Outro", "project", "p2", "assistant:outro:1"),
      assistant("Jarvis", "all", "p1", "assistant:jarvis:1"),
    ],
  }),
}));
vi.mock("../../state/entities", () => ({
  useQuietThreadShells: () => [],
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null
      ? null
      : {
          id: ref.threadId,
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          blockedOnThreadWait: false,
          latestRun: null,
          runtime: null,
          source: { latestVisibleMessage: null },
        },
}));

describe("ProjectAssistantRows", () => {
  it("lists only the project's own assistants and opens one", async () => {
    const onOpen = vi.fn();
    await using screen = await render(
      <ul>
        <ProjectAssistantRows
          members={[{ environmentId: "env", id: "p1" }]}
          routeThreadKey="env:assistant:revisor:1"
          onOpen={onOpen}
        />
      </ul>,
    );
    const rows = screen.container.querySelectorAll('[data-testid="project-assistant-row"]');
    expect([...rows].map((row) => row.getAttribute("aria-label"))).toEqual([
      "Revisor, Needs your approval",
      "Novo, Idle",
    ]);
    expect(rows[0]?.getAttribute("aria-current")).toBe("page");
    expect(rows[1]?.getAttribute("aria-current")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Revisor, Needs your approval" }));
    expect(onOpen).toHaveBeenCalledOnce();
    await userEvent.click(rows[1] as HTMLElement, { force: true });
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
