import type { Assistant } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    target: null as unknown,
    assistants: [] as unknown[],
    shell: null as unknown,
    projects: [] as unknown[],
    providers: null as unknown,
    sandbox: null as unknown,
    autonomy: { enabled: true } as { enabled: boolean },
    navigate: vi.fn(),
    openEditor: vi.fn(),
    writeAutonomy: vi.fn(),
    startSandbox: vi.fn(),
    startTurn: vi.fn(),
    alert: vi.fn(),
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.target }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "message-1" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <p>
      {props.label} {props.description}
    </p>
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; loading?: boolean; onPress: () => void }) => (
    <button disabled={props.loading} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: { title: string; children?: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));
vi.mock("./AssistantSchedulesSection", () => ({
  AssistantSchedulesSection: (props: { modelSelection: { model: string } | null }) => (
    <p>{`schedules ${props.modelSelection?.model ?? "no model"}`}</p>
  ),
}));
vi.mock("./AssistantWorkMemorySection", () => ({
  AssistantWorkMemorySection: () => <p>memory</p>,
}));
vi.mock("./AssistantWorkLibrarySection", () => ({
  AssistantWorkLibrarySection: () => <p>library</p>,
}));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.openEditor }));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: mocks.assistants }),
  useAssistantSandbox: () => mocks.sandbox,
  useAssistantSandboxActions: () => ({ start: mocks.startSandbox }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  useThreadShell: () => mocks.shell,
  useEnvironmentServerConfig: () => ({ providers: mocks.providers }),
}));
vi.mock("../../state/autonomy", () => ({
  useAutonomySettings: () => ({ autonomy: mocks.autonomy, write: mocks.writeAutonomy }),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.startTurn }));

import { AssistantWorkRouteScreen } from "./AssistantWorkRouteScreen";

const assistant = {
  id: "ada",
  name: "Ada",
  projectId: "project-1",
  threadId: "assistant:ada:1",
  workspace: "host",
  archivedAt: null,
} as unknown as Assistant;
const provider = (overrides: Record<string, unknown> = {}) => ({
  instanceId: "codex",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  models: [{ slug: "gpt-5" }],
  ...overrides,
});
const shell = (latestRun: unknown = null, lastErrorClass: string | null = null) => ({
  id: "assistant:ada:1",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  latestRun,
  runtime: { lastErrorClass },
});

let root: Root;
let container: HTMLDivElement;
const render = () => act(() => root.render(<AssistantWorkRouteScreen />));
const button = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  for (const mock of [
    mocks.navigate,
    mocks.openEditor,
    mocks.writeAutonomy,
    mocks.startSandbox,
    mocks.startTurn,
    mocks.alert,
  ])
    mock.mockReset();
  mocks.target = { environmentId: "hub", assistantId: "ada" };
  mocks.assistants = [{ environmentId: "hub", assistant }];
  mocks.projects = [{ environmentId: "hub", id: "project-1" }];
  mocks.providers = [provider()];
  mocks.shell = shell();
  mocks.sandbox = null;
  mocks.autonomy = { enabled: true };
});
afterEach(() => act(() => root.unmount()));

describe("AssistantWorkRouteScreen", () => {
  it("says it is ready and shows every section", () => {
    render();
    expect(container.textContent).toContain("Ready to work");
    expect(container.textContent).toContain("schedules gpt-5");
    expect(container.textContent).toContain("memory");
    expect(container.textContent).toContain("library");
    expect(container.textContent).not.toContain("Retry");
  });

  it("says when the assistant is not available", () => {
    mocks.target = null;
    render();
    expect(container.textContent).toContain("This assistant is not available.");
  });

  it.each([
    ["project missing", () => (mocks.projects = []), "Choose a project"],
    [
      "provider signed out",
      () => (mocks.providers = [provider({ auth: { status: "unauthenticated" } })]),
      "Sign in",
    ],
    [
      "model gone",
      () => (mocks.providers = [provider({ models: [{ slug: "other" }] })]),
      "Choose a model",
    ],
    ["autonomy paused", () => (mocks.autonomy = { enabled: false }), "Resume autonomy"],
  ] as const)("%s: shows why and offers the fix", (_name, arrange, label) => {
    arrange();
    render();
    expect(container.textContent).not.toContain("Ready to work");
    act(() => button(label).click());
    if (label === "Sign in")
      expect(mocks.navigate).toHaveBeenCalledWith("SettingsProviderAccounts");
    else if (label === "Resume autonomy")
      expect(mocks.writeAutonomy).toHaveBeenCalledWith({ enabled: true });
    else expect(mocks.openEditor).toHaveBeenCalledWith("hub", assistant);
  });

  it("starts a stopped sandbox and says why when it cannot", async () => {
    mocks.assistants = [
      { environmentId: "hub", assistant: { ...assistant, workspace: "sandbox" } },
    ];
    mocks.sandbox = { state: "stopped", error: null };
    mocks.startSandbox.mockResolvedValue({ ok: false, message: "Docker said no" });
    render();
    await act(async () => button("Start sandbox").click());
    expect(mocks.startSandbox).toHaveBeenCalledOnce();
    expect(mocks.alert).toHaveBeenCalledWith("Could not start the sandbox", "Docker said no");
  });

  it("retries a failed run by asking again, and a stopped run by continuing it", async () => {
    mocks.shell = shell({ runId: "run-1", status: "failed" });
    mocks.startTurn.mockResolvedValue({ _tag: "Success" });
    render();
    expect(container.textContent).toContain("Its last run failed.");
    await act(async () => button("Retry").click());
    expect(mocks.startTurn).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: expect.objectContaining({
        threadId: "assistant:ada:1",
        message: expect.objectContaining({ text: "That did not finish. Please try again." }),
        dispatchMode: "start",
      }),
    });
    expect(mocks.startTurn.mock.lastCall![0].input).not.toHaveProperty("manualContinuationOfRunId");

    mocks.shell = shell({ runId: "run-2", status: "interrupted" });
    render();
    expect(container.textContent).toContain("Its last run was stopped.");
    await act(async () => button("Retry").click());
    expect(mocks.startTurn.mock.lastCall![0].input).toMatchObject({
      manualContinuationOfRunId: "run-2",
      message: { text: "Continue where you left off." },
    });
  });
});
