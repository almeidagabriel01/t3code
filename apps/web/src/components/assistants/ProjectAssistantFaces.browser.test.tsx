import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ProjectAssistantFaces } from "./ProjectAssistantFaces";

const entry = (name: string, scope: "all" | "project", projectId: string) => ({
  environmentId: "env",
  assistant: {
    id: name,
    name,
    threadId: `assistant:${name}:1`,
    scope,
    projectId,
    avatar: null,
    icon: null,
  },
});

const state = vi.hoisted(() => ({
  names: [] as Array<[string, "all" | "project", string]>,
  sites: [] as Array<Record<string, string>>,
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: state.names.map(([n, s, p]) => entry(n, s, p)) }),
  useAssistantLiveWork: () => ({ sites: state.sites }),
}));

const members = [{ environmentId: "env", id: "p1" }];

describe("ProjectAssistantFaces", () => {
  it("shows two faces and +N for the project's own assistants, and opens without folding", async () => {
    state.names = [
      ["Ada", "project", "p1"],
      ["Bob", "project", "p1"],
      ["Cy", "project", "p1"],
      ["Dee", "project", "p2"],
      ["Eve", "all", "p1"],
    ];
    state.sites = [];
    const onOpen = vi.fn();
    const onFold = vi.fn();
    await using screen = await render(
      <div onClick={onFold}>
        <ProjectAssistantFaces members={members} onOpen={onOpen} />
      </div>,
    );
    const faces = screen.container.querySelectorAll('[data-testid="project-assistant-face"]');
    expect([...faces].map((f) => f.getAttribute("aria-label"))).toEqual(["Open Ada", "Open Bob"]);
    expect(screen.container.textContent).toContain("+1");
    await userEvent.click(screen.getByRole("button", { name: "Open Bob" }));
    expect(onOpen).toHaveBeenCalledWith({ environmentId: "env", threadId: "assistant:Bob:1" });
    screen.getByRole("button", { name: "Open Ada" }).element().focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onFold).not.toHaveBeenCalled();
  });

  it("puts an assistant working here first and opens the thread it works on", async () => {
    state.names = [
      ["Ada", "project", "p1"],
      ["Eve", "all", "p0"],
    ];
    const site = { environmentId: "env", assistantId: "Eve", face: "working" };
    state.sites = [
      { ...site, projectId: "p1", threadId: "task-1" },
      { ...site, projectId: "p2", threadId: "task-2" },
    ];
    const onOpen = vi.fn();
    await using screen = await render(<ProjectAssistantFaces members={members} onOpen={onOpen} />);
    const faces = screen.container.querySelectorAll('[data-testid="project-assistant-face"]');
    expect([...faces].map((f) => f.getAttribute("aria-label"))).toEqual([
      "Eve is working here",
      "Open Ada",
    ]);
    expect(faces[0]?.getAttribute("data-working")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Eve is working here" }));
    expect(onOpen).toHaveBeenCalledWith({ environmentId: "env", threadId: "task-1" });
  });

  it("renders nothing without project assistants", async () => {
    state.names = [["Eve", "all", "p1"]];
    state.sites = [];
    await using screen = await render(<ProjectAssistantFaces members={members} onOpen={vi.fn()} />);
    expect(screen.container.querySelector('[data-testid="project-assistant-faces"]')).toBeNull();
  });
});
