import type { ScheduledTask } from "@t3tools/contracts";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createDraft, editDraft } from "./scheduledTaskDraft";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    editor: null as unknown,
    assistant: null as null | { assistant: { name: string } },
    navigate: vi.fn(),
    upsert: vi.fn(),
    teams: [] as unknown[],
    selectedProjects: null as null | { id: string; environmentId: string }[],
    tasksByEnvironment: {} as Record<string, unknown[]>,
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: "android" },
  Pressable: (props: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  TextInput: (props: {
    accessibilityLabel?: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: mocks.navigate,
    goBack: vi.fn(),
    dispatch: vi.fn(),
    isFocused: () => false,
  }),
  usePreventRemove: () => undefined,
  useFocusEffect: () => undefined,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@expo/ui/community/datetime-picker", () => ({ DateTimePicker: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
  ENVIRONMENT_MACHINE_SYMBOLS: {},
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: ReadonlyArray<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/SegmentedControl", () => ({ SegmentedControl: () => null }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: vi.fn() }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("../layout/native-glass-header-items", () => ({ withNativeGlassHeaderItem: vi.fn() }));
vi.mock("../threads/new-task-context-presentation", () => ({
  resolveNewTaskBranchLabel: () => "main",
}));
vi.mock("../voice-input/useVoiceInputController", () => ({
  useVoiceInputController: () => ({ isBusy: false, blocksSubmission: false, cancel: vi.fn() }),
}));
vi.mock("./components/ScheduledTaskPromptField", () => ({ ScheduledTaskPromptField: () => null }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({ id: "environment", items: [] }),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: (props: { title?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));
const hubAndLab = [
  { environmentId: "hub", label: "Hub", serverConfig: null },
  { environmentId: "lab", label: "Lab", serverConfig: null },
];
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    availableTargets: hubAndLab,
    selectedTargets: hubAndLab,
    selectedProjects: mocks.selectedProjects,
  }),
}));
vi.mock("./scheduled-task-editor", () => ({
  useScheduledTaskDestinationLabel: () => "this conversation",
  useScheduledTaskEditor: () => {
    const [editor, setEditor] = useState(mocks.editor);
    return {
      editor,
      voiceOwnerKey: "k",
      readEditor: () => editor,
      setEditor: (update: unknown) =>
        setEditor((current: unknown) =>
          typeof update === "function" ? (update as (c: unknown) => unknown)(current) : update,
        ),
      hasChanges: false,
      draftForEnvironment: vi.fn(),
    };
  },
}));
vi.mock("./scheduled-task-editor-state", () => ({
  discardScheduledTaskEditor: vi.fn(),
  markScheduledTaskEditorSaved: vi.fn(),
  scheduledTaskEditorSessionAtom: {},
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { subscribe: vi.fn() } }));
vi.mock("../../state/assistants", () => ({
  useThreadAssistant: () => mocks.assistant,
  useAssistantEntries: () => ({ teams: mocks.teams }),
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () => null,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "p1", environmentId: "hub", title: "Alpha" },
    { id: "p2", environmentId: "hub", title: "Beta" },
  ],
  useEnvironmentServerConfig: () => null,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query?: { environmentId?: string }) => {
    const tasks = mocks.tasksByEnvironment[query?.environmentId ?? ""];
    return { data: tasks ? { tasks } : null };
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: (query: unknown) => query,
    upsertScheduledTask: { permissionAtom: () => ({}) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.upsert }));

import {
  SettingsScheduledTaskEditRouteScreen,
  SettingsScheduledTasksRouteScreen,
} from "./SettingsScheduledTasksRouteScreen";

const model = { instanceId: "codex", model: "gpt" };
const task = (threadId: string | null) =>
  ({
    id: "t1",
    title: "Digest",
    prompt: "Summarize",
    projectId: "p1",
    threadId,
    modelSelection: model,
    schedule: { type: "fixed_time", timeOfDay: "09:00" },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    enabled: true,
    runtimeMode: "full-access",
    interactionMode: "default",
    creationSource: "mobile",
  }) as unknown as ScheduledTask;

let root: Root;
let container: HTMLDivElement;
const open = (draft: unknown) => {
  mocks.editor = { environmentId: "hub", environmentLabel: "Hub", draft };
  act(() => root.render(<SettingsScheduledTaskEditRouteScreen />));
};
const find = (name: string | RegExp) => {
  const match = (text: string | null | undefined) =>
    typeof name === "string" ? text === name : name.test(text ?? "");
  return Array.from(container.querySelectorAll("button")).find(
    (entry) => match(entry.getAttribute("aria-label")) || match(entry.textContent),
  );
};
const press = (name: string | RegExp) => {
  const found = find(name);
  if (!found) throw new Error(`Missing button: ${String(name)}`);
  act(() => found.click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.assistant = null;
  mocks.selectedProjects = null;
  mocks.tasksByEnvironment = {};
  mocks.navigate.mockReset();
  mocks.upsert.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(() => act(() => root.unmount()));

describe("scheduled task bound to a conversation", () => {
  it("names the assistant, hides the project, model and workspace, and saves with its thread", async () => {
    mocks.assistant = { assistant: { name: "Jarvis" } };
    open(editDraft(task("thread-1")));
    expect(find("Runs in Jarvis's conversation")).toBeDefined();
    expect(find(/^Project,/)).toBeUndefined();
    expect(find(/^Model,/)).toBeUndefined();
    expect(find(/^Run in,/)).toBeUndefined();
    expect(container.querySelector('section[aria-label="Workspace"]')).toBeNull();

    await act(async () => find("Save changes")!.click());
    expect(mocks.upsert.mock.calls[0]?.[0].input).toMatchObject({ id: "t1", threadId: "thread-1" });
  });

  it("keeps the run settings and the thread picker for a thread that is not an assistant's", async () => {
    open(editDraft(task("thread-1")));
    expect(find(/^Runs in .* conversation$/)).toBeUndefined();
    expect(find(/^Project,/)).toBeDefined();
    expect(find(/^Thread,/)).toBeDefined();
    await act(async () => find("Save changes")!.click());
    expect(mocks.upsert.mock.calls[0]?.[0].input.threadId).toBe("thread-1");
  });
});

describe("scheduled task posting in a group chat", () => {
  it("names the group, hides the run settings and saves with the group and no thread", async () => {
    mocks.teams = [{ environmentId: "hub", team: { id: "g1", name: "Growth" } }];
    open({ ...editDraft(task("thread-1")), assistantTeamId: "g1" });
    expect(find(/^Group chat · Growth/)).toBeDefined();
    expect(find(/^Project,/)).toBeUndefined();
    await act(async () => find("Save routine")!.click());
    expect(mocks.upsert.mock.calls[0]?.[0].input).toMatchObject({
      assistantTeamId: "g1",
      threadId: null,
    });
  });

  it("running in a new thread instead restores the run settings and saves without the group", async () => {
    mocks.teams = [];
    open({ ...editDraft(task(null)), assistantTeamId: "g1" });
    expect(find(/^Group chat · Group/)).toBeDefined();
    press(/^Group chat/);
    expect(find(/^Project,/)).toBeDefined();
    await act(async () => find("Save changes")!.click());
    expect(mocks.upsert.mock.calls[0]?.[0].input.assistantTeamId).toBeNull();
  });
});

describe("scheduled task without a conversation", () => {
  it("changes project, keeping an explicit model, and the workspace fields", async () => {
    open(editDraft(task(null)));
    press("Beta");
    expect(find("Project, Beta")).toBeDefined();
    press(/^Model,/);
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsScheduledTaskModel");
    press(/^Base branch,/);
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsScheduledTaskBranch");

    press("Specific checkout");
    expect(find(/^Base branch,/)).toBeUndefined();
    act(() => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Checkout path"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "/work/tree",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => find("Save changes")!.click());
    expect(mocks.upsert.mock.calls[0]?.[0].input).toMatchObject({
      projectId: "p2",
      modelSelection: model,
      threadId: null,
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/work/tree" },
    });
  });

  it("runs in the project checkout", async () => {
    open(editDraft(task(null)));
    press("Project checkout");
    await act(async () => find("Save changes")!.click());
    expect(mocks.upsert.mock.calls[0]?.[0].input.workspaceStrategy).toEqual({ type: "root" });
  });

  it("replaces a model that was only the default when the project changes", () => {
    open(createDraft("p1" as never, model as never));
    press("Beta");
    expect(find("Project, Beta")).toBeDefined();
  });
});

describe("scheduled tasks screen with several projects selected", () => {
  it("lists the tasks of the union of the selected projects, on the environments that have one", () => {
    const titled = (id: string, projectId: string) => ({
      ...task(null),
      id,
      projectId,
      title: `Task ${id}`,
    });
    mocks.tasksByEnvironment = {
      hub: [titled("one", "p1"), titled("two", "p2"), titled("three", "p3")],
      lab: [titled("four", "q1")],
    };
    mocks.selectedProjects = [
      { environmentId: "hub", id: "p1" },
      { environmentId: "hub", id: "p2" },
    ];
    act(() => root.render(<SettingsScheduledTasksRouteScreen />));

    expect(find("Edit Task one")).toBeDefined();
    expect(find("Edit Task two")).toBeDefined();
    expect(find("Edit Task three")).toBeUndefined();
    expect(container.querySelector('section[aria-label="Lab"]')).toBeNull();
    expect(find("Edit Task four")).toBeUndefined();
  });
});
