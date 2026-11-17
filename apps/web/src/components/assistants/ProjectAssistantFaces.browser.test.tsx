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
  it("folds the project's own assistants into one cluster whose menu opens each, without folding the row", async () => {
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
      <div onClick={onFold} onPointerDown={onFold}>
        <ProjectAssistantFaces members={members} onOpen={onOpen} />
      </div>,
    );
    expect(
      screen.container
        .querySelector("[data-assistant-cluster]")
        ?.getAttribute("data-assistant-cluster"),
    ).toBe("3");
    await userEvent.click(screen.getByRole("button", { name: "Assistants in this project: 3" }));
    await expect.element(screen.getByRole("menuitem", { name: "Open Cy" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "Open Bob" }));
    expect(onOpen).toHaveBeenCalledWith({ environmentId: "env", threadId: "assistant:Bob:1" });
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
    await userEvent.click(screen.getByRole("button", { name: "Assistants in this project: 2" }));
    await expect.element(screen.getByRole("menuitem", { name: "Open Ada" })).toBeVisible();
    const items = document.querySelectorAll('[data-testid="project-assistant-face"]');
    expect([...items].map((item) => item.textContent)).toEqual(["Eve is working here", "Open Ada"]);
    expect(items[0]?.getAttribute("data-working")).toBe("true");
    await userEvent.click(screen.getByRole("menuitem", { name: "Eve is working here" }));
    expect(onOpen).toHaveBeenCalledWith({ environmentId: "env", threadId: "task-1" });
  });

  it("opens a lone assistant straight from the cluster, by click and by keyboard", async () => {
    state.names = [["Ada", "project", "p1"]];
    state.sites = [];
    const onOpen = vi.fn();
    const onFold = vi.fn();
    await using screen = await render(
      <div onClick={onFold} onKeyDown={onFold}>
        <ProjectAssistantFaces members={members} onOpen={onOpen} />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open Ada" }));
    screen.getByRole("button", { name: "Open Ada" }).element().focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith({ environmentId: "env", threadId: "assistant:Ada:1" });
    expect(onFold).not.toHaveBeenCalled();
  });

  it("renders nothing without project assistants", async () => {
    state.names = [["Eve", "all", "p1"]];
    state.sites = [];
    await using screen = await render(<ProjectAssistantFaces members={members} onOpen={vi.fn()} />);
    expect(screen.container.querySelector('[data-testid="project-assistant-faces"]')).toBeNull();
  });
});
