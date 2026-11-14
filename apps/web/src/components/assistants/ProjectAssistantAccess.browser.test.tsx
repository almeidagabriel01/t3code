import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { ProjectAssistantAccess, ProjectAssistantAccessSettings } from "./ProjectAssistantAccess";
import {
  offerProjectAssistantAccess,
  ProjectAssistantAccessHost,
} from "./ProjectAssistantAccessDialog";

const state = vi.hoisted(() => {
  const assistant = (id: string, scope: string, projectId: string, projectIds: string[]) => ({
    id,
    name: id,
    scope,
    projectId,
    projectIds,
    archivedAt: null,
  });
  const team = (id: string, memberIds: string[], projectIds: string[]) => ({
    id,
    name: id,
    memberIds,
    archivedAt: null,
    projectIds,
  });
  const result = {
    toasts: [] as Array<{ actionProps: { onClick: () => void } }>,
    teamUpdates: [] as unknown[],
    assistantUpdates: [] as unknown[],
    assistants: [
      assistant("everywhere", "all", "home", []),
      assistant("homey", "project", "p1", ["p1"]),
      assistant("viagroup", "project", "p0", ["p0"]),
      assistant("free", "project", "p0", ["p0"]),
    ],
    teams: [team("has", ["viagroup"], ["p1"]), team("lacks", [], [])],
    entries: () => ({
      active: result.assistants.map((assistant) => ({ environmentId: "env", assistant })),
      teams: result.teams.map((team) => ({ environmentId: "env", team })),
      activeTeams: result.teams.map((team) => ({ environmentId: "env", team })),
    }),
  };
  return result;
});
vi.mock("../ui/toast", () => ({
  toastManager: { add: (toast: (typeof state.toasts)[number]) => state.toasts.push(toast) },
}));
vi.mock("../../state/assistants", () => ({
  readAssistantEntries: () => state.entries(),
  useAssistantEntries: () => state.entries(),
  useAssistantTeamActions: () => ({
    canAct: true,
    update: async (input: unknown) => {
      state.teamUpdates.push(input);
      return { ok: true, value: undefined };
    },
  }),
  useAssistantActions: () => ({
    canAct: true,
    update: async (input: unknown) => {
      state.assistantUpdates.push(input);
      return { ok: true, value: undefined };
    },
  }),
}));

const open = () =>
  render(<ProjectAssistantAccess environmentId={"env" as never} projectId={"p1" as never} />);

describe("ProjectAssistantAccess", () => {
  it("one click gives a whole group the project or takes it back", async () => {
    state.teamUpdates = [];
    await using _screen = await open();
    await expect.element(page.getByRole("checkbox", { name: "has" })).toBeChecked();
    await userEvent.click(page.getByRole("checkbox", { name: "lacks" }));
    await vi.waitFor(() =>
      expect(state.teamUpdates).toEqual([{ teamId: "lacks", addProjectIds: ["p1"] }]),
    );
    await expect.element(page.getByRole("checkbox", { name: "has" })).toBeEnabled();
    await userEvent.click(page.getByRole("checkbox", { name: "has" }));
    await vi.waitFor(() =>
      expect(state.teamUpdates).toContainEqual({ teamId: "has", removeProjectIds: ["p1"] }),
    );
  });

  it("locks what this screen cannot change and sends an assistant's own list", async () => {
    state.assistantUpdates = [];
    await using _screen = await open();
    await userEvent.click(page.getByRole("button", { name: "Individual assistants" }));
    await expect.element(page.getByRole("checkbox", { name: "everywhere" })).toBeDisabled();
    await expect.element(page.getByText("All projects")).toBeVisible();
    await expect.element(page.getByRole("checkbox", { name: "homey" })).toBeDisabled();
    await expect.element(page.getByText("Home project")).toBeVisible();
    await expect.element(page.getByRole("checkbox", { name: "viagroup" })).toBeDisabled();
    await expect.element(page.getByText("Via has")).toBeVisible();
    await userEvent.click(page.getByRole("checkbox", { name: "free" }));
    await vi.waitFor(() =>
      expect(state.assistantUpdates).toEqual([{ assistantId: "free", projectIds: ["p0", "p1"] }]),
    );
  });

  it("offers access after an add only where an assistant could use it", async () => {
    state.toasts = [];
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <ProjectAssistantAccessHost />
      </AppAtomRegistryProvider>,
    );
    offerProjectAssistantAccess("elsewhere" as never, "p9" as never);
    expect(state.toasts).toHaveLength(0);
    offerProjectAssistantAccess("env" as never, "p1" as never);
    expect(state.toasts).toHaveLength(1);
    state.toasts[0]!.actionProps.onClick();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Assistants with access")).toBeVisible();
    await expect.element(dialog.getByRole("checkbox", { name: "has" })).toBeChecked();
  });

  it("shows the Settings section only for environments with assistants", async () => {
    await using _screen = await render(
      <ProjectAssistantAccessSettings
        members={[
          { environmentId: "env" as never, id: "p1" as never },
          { environmentId: "bare" as never, id: "p2" as never },
        ]}
      />,
    );
    await expect.element(page.getByText("Assistants with access")).toBeVisible();
    expect(page.getByRole("checkbox", { name: "has" }).all()).toHaveLength(1);
  });
});
