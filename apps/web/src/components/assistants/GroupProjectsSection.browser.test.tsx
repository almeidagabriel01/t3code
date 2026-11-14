import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";

const state = vi.hoisted(() => {
  const team = {
    id: "t1",
    name: "Ops",
    memberIds: ["ana", "bob"],
    leadId: null,
    archivedAt: null,
    projectIds: [] as string[],
    instructions: "",
    memories: [] as string[],
  };
  const assistant = (id: string, scope: string) => ({
    id,
    name: id,
    scope,
    projectId: "p0",
    projectIds: ["p0"],
    archivedAt: null,
  });
  return {
    team,
    updates: [] as unknown[],
    assistants: [assistant("ana", "project"), assistant("bob", "project"), assistant("cy", "all")],
  };
});
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: state.assistants.map((assistant) => ({ environmentId: "env", assistant })),
    teams: [{ environmentId: "env", team: state.team }],
  }),
  useAssistantTeamActions: () => ({
    canAct: true,
    update: async (input: unknown) => {
      state.updates.push(input);
      return { ok: true, value: state.team };
    },
  }),
  useAssistantGroupActions: () => ({ canConverse: true }),
  useAssistantGroupChat: () => null,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () =>
    ["p1", "p2", "p3"].map((id) => ({
      environmentId: "env",
      id,
      title: `Project ${id}`,
      workspaceRoot: `/work/${id}`,
    })),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

const { AssistantGroupSettingsHost } = await import("./AssistantGroupSettingsDialog");
const { openAssistantGroupSettings, assistantGroupSettingsAtom } =
  await import("./assistantTeamState");
const { appAtomRegistry, AppAtomRegistryProvider } = await import("~/rpc/atomRegistry");

describe("group projects", () => {
  it("counts who gains access and saves every field in one update", async () => {
    state.updates = [];
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <AssistantGroupSettingsHost />
      </AppAtomRegistryProvider>,
    );
    openAssistantGroupSettings({ environmentId: "env" as never, teamId: "t1" as never });
    await userEvent.click(page.getByRole("checkbox", { name: "Project p1" }));
    await expect.element(page.getByText("2 members gain access")).toBeVisible();
    await userEvent.click(page.getByRole("checkbox", { name: "Project p3" }));
    await userEvent.fill(page.getByLabelText("Group instructions"), "Be kind");
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(state.updates).toEqual([
        { teamId: "t1", instructions: "Be kind", memories: [], projectIds: ["p1", "p3"] },
      ]),
    );
    appAtomRegistry.set(assistantGroupSettingsAtom, null);
  });
});
