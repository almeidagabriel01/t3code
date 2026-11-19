import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";

const state = vi.hoisted(() => {
  const assistant = (workspace: string, scope: string) => ({
    id: "ada",
    name: "Ada",
    role: "",
    handle: "ada",
    scope,
    workspace,
    projectId: "p0",
    projectIds: [],
    toolAccess: "edit",
    askBeforeActing: false,
    autonomy: { onProblem: "fix-small" },
    budget: null,
    threadId: null,
    icon: null,
    avatar: null,
    archivedAt: null,
    defaultEnvironment: null,
  });
  return {
    assistant: assistant("host", "all"),
    make: assistant,
    team: {
      id: "t1",
      name: "Ops",
      memberIds: ["ada"],
      leadId: null,
      archivedAt: null,
      defaultEnvironment: null,
    },
    updates: [] as unknown[],
  };
});
vi.mock("../../state/assistants", () => {
  const update = async (input: unknown) => {
    state.updates.push(input);
    return { ok: true, value: null };
  };
  return {
    useAssistantEntries: () => ({
      active: [{ environmentId: "env", assistant: state.assistant }],
      archived: [],
      teams: [{ environmentId: "env", team: state.team }],
    }),
    useAssistantGroupChat: () => null,
    useAssistantLiveWork: () => ({ threads: [] }),
    useAssistantSpend: () => null,
    useAssistantActions: () => ({ canAct: true, update }),
    useAssistantTeamActions: () => ({ canAct: true, update }),
    useAssistantGroupActions: () => ({ canMarkRead: true }),
    setAssistantTaskDismissed: vi.fn(),
  };
});
vi.mock("../sidebar/useSidebarZones", () => ({
  useAssistantStatus: () => ({
    of: () => ({ mood: "idle", reading: false, since: null, detail: "Idle", queued: 0 }),
  }),
}));
vi.mock("./useUsageLimitLabel", () => ({ useUsageLimitLabel: () => () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useQuietThreadShells: () => [],
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentProviders: () => new Map(),
  useEnvironmentIdentities: () => [],
}));
vi.mock("../../state/peerLinks", async () => {
  const { Atom } = await import("effect/reactivity");
  const offered = Atom.make(true);
  return { offersLinkedEnvironmentsAtom: () => offered, peerLinkEnvironment: { list: () => null } };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { links: [{ environmentId: "devbox-env", label: "devbox", status: "reachable" }] },
  }),
}));

const { AssistantInfoPanel } = await import("./AssistantInfoPanel");
const { openAssistantInfo, closeAssistantInfo } = await import("./assistantInfoState");
const { AppAtomRegistryProvider } = await import("~/rpc/atomRegistry");

const renderPanel = (target: Parameters<typeof openAssistantInfo>[0]) => {
  openAssistantInfo(target);
  return render(
    <AppAtomRegistryProvider>
      <AssistantInfoPanel />
    </AppAtomRegistryProvider>,
  );
};
const trigger = () =>
  page.getByTestId("assistant-info-panel").getByRole("combobox", { name: "Default environment" });

describe("Default environment in the info panel", () => {
  it("saves an assistant's pick at once", async () => {
    state.updates = [];
    state.assistant = state.make("host", "all");
    await using _screen = await renderPanel({
      kind: "assistant",
      environmentId: "env" as never,
      assistantId: "ada" as never,
    });
    await userEvent.click(trigger());
    await userEvent.click(page.getByRole("option", { name: "devbox" }));
    await vi.waitFor(() =>
      expect(state.updates).toEqual([{ assistantId: "ada", defaultEnvironment: "devbox-env" }]),
    );
    closeAssistantInfo();
  });

  it("saves a group's pick at once", async () => {
    state.updates = [];
    await using _screen = await renderPanel({
      kind: "group",
      environmentId: "env" as never,
      teamId: "t1" as never,
    });
    await userEvent.click(trigger());
    await userEvent.click(page.getByRole("option", { name: /Auto/ }));
    await vi.waitFor(() =>
      expect(state.updates).toEqual([{ teamId: "t1", defaultEnvironment: "auto" }]),
    );
    closeAssistantInfo();
  });

  it.each([
    { name: "sandbox", workspace: "sandbox", scope: "all" },
    { name: "project", workspace: "host", scope: "project" },
  ])("is off for a $name assistant", async ({ workspace, scope }) => {
    state.assistant = state.make(workspace, scope);
    await using _screen = await renderPanel({
      kind: "assistant",
      environmentId: "env" as never,
      assistantId: "ada" as never,
    });
    await expect.element(trigger()).toBeDisabled();
    closeAssistantInfo();
  });
});
