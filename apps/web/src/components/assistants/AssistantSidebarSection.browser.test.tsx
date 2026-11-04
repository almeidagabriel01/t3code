import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AssistantSidebarSection } from "./AssistantSidebarSection";

const state = vi.hoisted(() => ({
  names: [] as string[],
  enabled: true,
  collapsed: false,
  working: new Set<string>(),
  update: vi.fn(),
}));

vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: state.names.map((name) => ({
      environmentId: "env",
      assistant: {
        id: name.toLowerCase(),
        name,
        handle: name.toLowerCase(),
        isDefault: name === "Jarvis",
        threadId: `assistant:${name.toLowerCase()}:1`,
      },
    })),
    archived: [],
  }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null
      ? null
      : {
          id: ref.threadId,
          lastVisitedAt: null,
          latestRun: null,
          runtime: state.working.has(ref.threadId) ? { status: "running" } : null,
        },
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: Record<string, boolean>) => unknown) =>
    select({
      sidebarShowAssistantsSection: state.enabled,
      sidebarAssistantsCollapsed: state.collapsed,
    }),
  updateClientSettings: state.update,
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({ canAct: true, reset: vi.fn(), archive: vi.fn() }),
}));

function setup(
  names: string[],
  options: { enabled?: boolean; collapsed?: boolean; working?: string[] } = {},
) {
  state.names = names;
  state.enabled = options.enabled ?? true;
  state.collapsed = options.collapsed ?? false;
  state.working = new Set(options.working ?? []);
  state.update.mockClear();
}

const element = (onOpenThread = vi.fn(), routeThreadKey: string | null = null) => (
  <ul>
    <AssistantSidebarSection
      routeThreadKey={routeThreadKey}
      environmentLabelById={new Map()}
      onOpenThread={onOpenThread}
    />
  </ul>
);

const rows = (container: HTMLElement) =>
  container.querySelectorAll('[data-testid="sidebar-assistant-row"]');

describe("AssistantSidebarSection", () => {
  it.each([
    { name: "has no assistants", names: [], options: {} },
    { name: "is switched off", names: ["Jarvis"], options: { enabled: false } },
  ])("renders nothing when it $name", async ({ names, options }) => {
    setup(names, options);
    await using screen = await render(element());
    expect(screen.container.textContent).toBe("");
  });

  it("collapses to one line and expands back through the setting", async () => {
    setup(["Jarvis", "Revisor"]);
    await using screen = await render(element());
    expect(rows(screen.container)).toHaveLength(2);
    await expect.element(screen.getByRole("button", { name: "New assistant" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Collapse assistants" }));
    expect(state.update).toHaveBeenCalledWith({ sidebarAssistantsCollapsed: true });

    setup(["Jarvis", "Revisor"], { collapsed: true });
    await screen.rerender(element());
    expect(rows(screen.container)).toHaveLength(0);
    expect(screen.container.querySelector('[aria-label="New assistant"]')).toBeNull();
    await userEvent.click(screen.getByRole("treeitem", { name: "Assistants, 2" }));
    expect(state.update).toHaveBeenLastCalledWith({ sidebarAssistantsCollapsed: false });
  });

  it("opens an assistant from its avatar and caps the strip with +N", async () => {
    const names = ["Jarvis", "Revisor", "Pesquisador", "Aprovador", "Escritor", "Tradutor"];
    setup(names, { collapsed: true, working: ["assistant:revisor:1"] });
    const onOpen = vi.fn();
    await using screen = await render(element(onOpen, "env:assistant:jarvis:1"));
    const avatars = screen.container.querySelectorAll('button[aria-label^="Open "]');
    expect([...avatars].map((avatar) => avatar.getAttribute("aria-label"))).toEqual([
      "Open Jarvis",
      "Open Revisor, working",
      "Open Pesquisador",
      "Open Aprovador",
      "Open Escritor",
    ]);
    expect(avatars[0]?.getAttribute("aria-current")).toBe("page");
    await userEvent.click(screen.getByRole("button", { name: "Open Revisor, working" }));
    expect(onOpen).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("assistant:revisor:1"),
    });
    expect(state.update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Show all 6 assistants" }));
    expect(state.update).toHaveBeenCalledWith({ sidebarAssistantsCollapsed: false });
  });
});
