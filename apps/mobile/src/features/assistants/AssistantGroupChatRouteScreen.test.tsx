import { applyAssistantGroupsEvent } from "@t3tools/client-runtime/assistantGroupChat";
import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Item = { message: { id: string } };

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    /** Group threads that wait on the user's approval. */
    waiting: new Set<string>(),
    live: null as unknown,
    teams: [] as unknown[],
    environmentIds: ["hub"],
    canPost: true,
    canAct: true,
    post: vi.fn(),
    taskAction: vi.fn(),
    olderThan: vi.fn(),
    alert: vi.fn(),
    dispatch: vi.fn(),
    goBack: vi.fn(),
    selectDetail: vi.fn(),
    openTeam: { edit: vi.fn() },
    openEditor: vi.fn(),
    schedule: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    scrollToEnd: vi.fn(),
  },
}));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode; testID?: string }) => (
    <div data-testid={props.testID}>{props.children}</div>
  ),
  ScrollView: Children,
  Platform: { OS: "ios" },
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
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: Children }));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardAvoidingView: Children }));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    ref?: Ref<unknown>;
    data: Item[];
    keyExtractor: (item: Item) => string;
    renderItem: (info: { item: Item }) => ReactNode;
    onStartReached: () => void;
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
  }) => {
    useImperativeHandle(props.ref, () => ({ scrollToEnd: mocks.scrollToEnd }));
    return (
      <div>
        {props.ListHeaderComponent}
        <button aria-label="start reached" onClick={props.onStartReached} />
        {props.data.length === 0
          ? props.ListEmptyComponent
          : props.data.map((item) => (
              <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
            ))}
      </div>
    );
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mocks.goBack, dispatch: mocks.dispatch }),
  StackActions: { push: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; testID?: string }) => (
    <span data-testid={props.testID}>{props.children}</span>
  ),
  AppTextInput: (props: {
    accessibilityLabel?: string;
    placeholder?: string;
    editable?: boolean;
    value: string;
    onChangeText: (value: string) => void;
    onSelectionChange: (event: { nativeEvent: { selection: { start: number } } }) => void;
  }) => (
    <textarea
      aria-label={props.accessibilityLabel}
      placeholder={props.placeholder}
      disabled={props.editable === false}
      value={props.value}
      onChange={(event) => {
        props.onChangeText(event.target.value);
        props.onSelectionChange({
          nativeEvent: { selection: { start: event.target.selectionStart } },
        });
      }}
    />
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: {
    title: string;
    subtitle?: string;
    menus?: Array<{ items: Array<{ title: string; disabled?: boolean; onPress: () => void }> }>;
  }) => (
    <header>
      <h1>{props.title}</h1>
      <p>{props.subtitle}</p>
      {props.menus?.[0]?.items.map((item) => (
        <button
          key={item.title}
          aria-label={`header:${item.title}`}
          disabled={item.disabled}
          onClick={item.onPress}
        />
      ))}
    </header>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string; detail: string }) => (
    <p>{`${props.title}: ${props.detail}`}</p>
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: Array<{ id: string; title: string; attributes?: { disabled?: boolean } }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`menu:${action.title}`}
          disabled={action.attributes?.disabled}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </>
  ),
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { markdown: string }) => <span>{props.markdown}</span>,
}));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null || !mocks.waiting.has(ref.threadId)
      ? null
      : {
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          queuedMessageCount: 0,
          runtime: null,
          blockedOnThreadWait: false,
          latestRun: null,
          source: { latestVisibleMessage: null },
        },
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    teams: mocks.teams,
    environmentIds: mocks.environmentIds,
    active: members.map((assistant) => ({ environmentId: "hub", assistant })),
    archived: [],
  }),
  useAssistantGroupChat: () => mocks.live,
  useAssistantGroupActions: () => ({
    canPost: mocks.canPost,
    canAct: mocks.canAct,
    post: mocks.post,
    taskAction: mocks.taskAction,
    olderThan: mocks.olderThan,
  }),
}));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { name: string } }) => (
    <i>{`av:${props.assistant.name}`}</i>
  ),
}));
vi.mock("./assistantTeamTarget", () => ({ useOpenAssistantTeam: () => mocks.openTeam }));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.openEditor }));
vi.mock("./useScheduleInGroup", () => ({ useScheduleInGroup: () => mocks.schedule }));
vi.mock("./useAssistantFlows", () => ({
  useAssistantTeamFlows: () => ({
    canAct: true,
    archive: mocks.archive,
    restore: mocks.restore,
  }),
}));

import { AssistantGroupChatRouteScreen } from "./AssistantGroupChatRouteScreen";

const member = (id: string, name: string, role: string) => ({
  id,
  name,
  handle: id,
  role,
  icon: null,
  avatar: null,
  archivedAt: null,
});
const members = [
  member("ada", "Ada", "Dev"),
  member("beto", "Beto", ""),
  member("jarvis", "Jarvis", ""),
];
const team = (extra: object = {}) => ({
  environmentId: "hub",
  team: {
    id: "g1",
    name: "Crew",
    memberIds: ["ada", "beto", "jarvis"],
    leadId: "jarvis",
    archivedAt: null,
    ...extra,
  },
});
const message = (id: string, seq: number, extra: object = {}) => ({
  id,
  teamId: "g1",
  seq,
  author: "assistant",
  assistantId: "ada",
  authorLabel: null,
  kind: "message",
  text: id,
  replyToMessageId: null,
  taskId: null,
  createdAt: `2026-11-07T10:00:0${seq}Z`,
  ...extra,
});
const task = (id: string, status: string, ownerId: string, extra: object = {}) => ({
  id,
  teamId: "g1",
  rootId: id,
  parentId: null,
  kind: "root",
  requestMessageId: "m1",
  ownerId,
  instruction: `do ${id}`,
  status,
  reason: null,
  threadId: `assistant:${ownerId}:g-0123456789abcdef`,
  createdAt: `2026-11-07T10:00:0${id.length}Z`,
  updatedAt: "2026-11-07T10:00:09Z",
  ...extra,
});
const snapshot = (messages: object[], tasks: object[] = [], hasMore = false): unknown =>
  applyAssistantGroupsEvent(null, { type: "snapshot", messages, tasks, hasMore } as never);

const FEED = [
  message("m1", 1, { author: "user", assistantId: null, text: "@ada build @everyone" }),
  message("m2", 2, { kind: "routing", author: "assistant", text: "Jarvis assigned Ada" }),
  message("m3", 3, { text: "Ada says hi", taskId: "t1" }),
  message("m4", 4, {
    assistantId: "beto",
    text: "Beto replies",
    replyToMessageId: "m3",
  }),
];

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(() =>
    root.render(
      <AssistantGroupChatRouteScreen
        route={
          {
            key: "k",
            name: "AssistantGroupChat",
            params: { environmentId: "hub", teamId: "g1" },
          } as never
        }
      />,
    ),
  );
const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const click = (label: string) => act(async () => byLabel(label)?.click());
const input = () =>
  container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the group"]')!;
const type = (value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input(),
      value,
    );
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
const text = () => container.textContent ?? "";
const recipients = () => container.querySelector('[data-testid="group-recipients"]')?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  Object.assign(mocks, {
    teams: [team()],
    environmentIds: ["hub"],
    canPost: true,
    canAct: true,
    live: snapshot(FEED, [
      task("t1", "paused", "ada", { reason: "stopped" }),
      task("t22", "running", "beto"),
    ]),
  });
  for (const fn of [
    mocks.post,
    mocks.taskAction,
    mocks.olderThan,
    mocks.alert,
    mocks.dispatch,
    mocks.selectDetail,
    mocks.openEditor,
    mocks.schedule,
    mocks.archive,
    mocks.restore,
    mocks.scrollToEnd,
    mocks.openTeam.edit,
  ])
    fn.mockReset();
  mocks.post.mockResolvedValue({ ok: true, value: {} });
  mocks.taskAction.mockResolvedValue({ ok: true, value: {} });
});
afterEach(() => act(() => root.unmount()));

describe("group chat feed", () => {
  it("shows each kind of row, the header summary, roles, running count and task cards", () => {
    render();
    expect(container.querySelector("h1")?.textContent).toBe("Crew");
    expect(text()).toContain("@ada");
    expect(container.querySelectorAll('[data-testid="group-request"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="group-note"]')?.textContent).toContain(
      "Jarvis assigned Ada",
    );
    expect(container.querySelectorAll('[data-testid="group-answer"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="group-role"]')?.textContent).toBe("Dev");
    expect(text()).toContain("In reply to Ada");
    expect(container.querySelector("h1 + p")?.textContent).toMatch(/ · 1 running$/);
    const statuses = Array.from(
      container.querySelectorAll('[data-testid="group-task-status"]'),
    ).map((node) => node.textContent);
    expect(statuses).toEqual(["Running", "Paused"]);
    expect(text()).toContain("Stopped");
  });

  it("names the owner on cards under a request and says when the lead is still choosing", () => {
    mocks.live = snapshot(
      [
        message("m1", 1, { author: "user", assistantId: null, text: "@ada go" }),
        message("m5", 5, { author: "user", assistantId: null, text: "who takes this?" }),
        message("m6", 6, { assistantId: "ada", text: "done" }),
        message("m7", 7, {
          author: "user",
          assistantId: null,
          text: "why?",
          replyToMessageId: "m6",
        }),
      ],
      [task("t1", "running", "ada")],
    );
    render();
    expect(container.querySelector('[data-testid="group-task-card"]')?.textContent).toContain(
      "Ada",
    );
    expect(container.querySelectorAll('[data-testid="group-routing"]')).toHaveLength(2);
    expect(text()).toContain("Reply to Ada");
    expect(container.querySelector('[data-testid="group-routing"]')?.textContent).toBe(
      "Jarvis (lead) is choosing who answers…",
    );
  });

  it("says on a running card when its member waits for the user's approval", () => {
    mocks.waiting = new Set(["assistant:ada:g-0123456789abcdef"]);
    mocks.live = snapshot(
      [message("m1", 1, { author: "user", assistantId: null, text: "@ada go" })],
      [task("t1", "running", "ada"), task("t22", "running", "bo")],
    );
    render();
    const needs = container.querySelectorAll('[data-testid="group-task-needs"]');
    expect(needs).toHaveLength(1);
    expect(needs[0]?.textContent).toBe("Needs your approval · Open the conversation to answer");
    mocks.waiting = new Set();
  });

  it("says what to do in an empty chat, and nothing before the first snapshot", () => {
    mocks.live = null;
    render();
    expect(text()).not.toContain("No messages yet");
    mocks.live = snapshot([]);
    render();
    expect(text()).toContain("@ada to give one a task");
    expect(text()).toContain("Jarvis routes it");
    mocks.teams = [team({ memberIds: [] })];
    render();
    expect(text()).toContain("Add assistants to this group in Edit group");
  });

  it("a missing group says so once its environment loaded", () => {
    mocks.teams = [];
    render();
    expect(text()).toContain("Group not found");
    mocks.environmentIds = [];
    render();
    expect(text()).not.toContain("Group not found");
  });

  it("loads earlier messages from the button or by scrolling up, and shows them", async () => {
    mocks.live = snapshot(FEED, [], true);
    mocks.olderThan.mockResolvedValue({
      ok: true,
      value: {
        messages: [message("m0", 0, { author: "user", assistantId: null, text: "much older" })],
        tasks: [],
        hasMore: false,
      },
    });
    render();
    await click("Load earlier messages");
    expect(mocks.olderThan).toHaveBeenCalledOnce();
    expect(text()).toContain("much older");
    expect(byLabel("Load earlier messages")).toBeNull();
    await click("start reached");
    expect(mocks.olderThan).toHaveBeenCalledOnce();
  });

  it("a failed page is reported and the button stays", async () => {
    mocks.live = snapshot(FEED, [], true);
    mocks.olderThan.mockResolvedValue({ ok: false, message: "offline" });
    render();
    await click("start reached");
    expect(mocks.alert).toHaveBeenCalledWith("Could not load earlier messages", "offline");
    expect(byLabel("Load earlier messages")).not.toBeNull();
  });
});

describe("group composer", () => {
  it("picks a member from @, previews the recipients and sends", async () => {
    render();
    expect(recipients()).toBe("");
    await type("@");
    expect(byLabel("Mention Ada")).not.toBeNull();
    expect(byLabel("Mention everyone")).not.toBeNull();
    await click("Mention Ada");
    expect(input().value).toBe("@ada ");
    expect(byLabel("Mention Ada")).toBeNull();
    await type("@ada do it");
    expect(recipients()).toBe("To Ada");
    await click("Send");
    expect(mocks.post).toHaveBeenCalledWith({ teamId: "g1", text: "@ada do it" });
    expect(input().value).toBe("");
    expect(mocks.scrollToEnd).toHaveBeenCalledOnce();
  });

  it("previews everyone, the lead's routing and the missing mention", async () => {
    render();
    await type("@everyone ship");
    expect(recipients()).toBe("To everyone");
    await type("hello");
    expect(recipients()).toBe("Jarvis (lead) will route it");
    mocks.teams = [team({ leadId: null })];
    render();
    await type("hello again");
    expect(recipients()).toBe("Mention someone");
  });

  it("offers @everyone and marks the lead in the picker", async () => {
    render();
    await type("@e");
    expect(byLabel("Mention everyone")).not.toBeNull();
    expect(byLabel("Mention Ada")).toBeNull();
    await click("Mention everyone");
    expect(input().value).toBe("@everyone ");
    await type("@j");
    expect(byLabel("Mention Jarvis")?.textContent).toContain("lead");
  });

  it("keeps the draft and says to mention someone when the server asks for it", async () => {
    mocks.post.mockResolvedValue({ ok: false, message: "raw", reason: "mention_required" });
    render();
    await type("no mention");
    await click("Send");
    expect(text()).toContain("Mention a member with @, or set a lead in Edit group.");
    expect(input().value).toBe("no mention");
    await type("no mention!");
    expect(text()).not.toContain("Mention a member with @");
  });

  it("explains an archived refusal and shows any other message as is", async () => {
    mocks.post.mockResolvedValue({ ok: false, message: "raw", reason: "archived" });
    render();
    await type("hi");
    await click("Send");
    expect(text()).toContain("This group is archived. Restore it to write here.");
    mocks.post.mockResolvedValue({ ok: false, message: "server down", reason: null });
    await click("Send");
    expect(text()).toContain("server down");
  });

  it("replies to a member's message from the row button or its menu, then clears or sends", async () => {
    render();
    await click("Reply to Ada");
    expect(container.querySelector('[data-testid="group-reply-chip"]')?.textContent).toBe(
      "Replying to Ada",
    );
    await click("Cancel reply");
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
    await click("menu:Reply");
    expect(text()).toContain("Replying to Ada");
    await type("@ada thanks");
    await click("Send");
    expect(mocks.post).toHaveBeenCalledWith({
      teamId: "g1",
      text: "@ada thanks",
      replyToMessageId: "m3",
    });
    expect(container.querySelector('[data-testid="group-reply-chip"]')).toBeNull();
  });

  it("does not send without text or permission", async () => {
    render();
    await click("Send");
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.canPost = false;
    render();
    expect(input().disabled).toBe(true);
  });
});

describe("task cards", () => {
  it("stops a running task, resumes and cancels a paused one, and reassigns to another member", async () => {
    render();
    await click("Stop");
    expect(mocks.taskAction).toHaveBeenLastCalledWith({ taskId: "t22", action: "stop" });
    await click("Resume");
    expect(mocks.taskAction).toHaveBeenLastCalledWith({ taskId: "t1", action: "resume" });
    await click("Cancel");
    expect(mocks.taskAction).toHaveBeenLastCalledWith({ taskId: "t1", action: "cancel" });
    // Reassign lists the members but the owner.
    expect(byLabel("menu:Ada")).toBeNull();
    await click("menu:Beto");
    expect(mocks.taskAction).toHaveBeenLastCalledWith({
      taskId: "t1",
      action: "reassign",
      ownerId: "beto",
    });
  });

  it("reports a refused action and disables the buttons without permission", async () => {
    mocks.taskAction.mockResolvedValue({ ok: false, message: "nope" });
    render();
    await click("Stop");
    expect(mocks.alert).toHaveBeenCalledWith("Could not update the task", "nope");
    mocks.canAct = false;
    render();
    expect(byLabel("Stop")?.disabled).toBe(true);
    expect(byLabel("Reassign")?.disabled).toBe(true);
  });

  const openFirstConversation = () =>
    act(async () =>
      container.querySelectorAll<HTMLButtonElement>('[aria-label="Open conversation"]')[0]!.click(),
    );
  const THREAD = {
    name: "Thread",
    params: { environmentId: "hub", threadId: "assistant:beto:g-0123456789abcdef" },
  };

  it("opens the task's conversation by pushing it onto the stack", async () => {
    render();
    await openFirstConversation();
    expect(mocks.dispatch).toHaveBeenCalledWith(THREAD);
    expect(mocks.selectDetail).not.toHaveBeenCalled();
  });
});

describe("group header and archive", () => {
  it("its menu edits, adds an assistant, schedules and archives", async () => {
    render();
    await click("header:Edit group");
    expect(mocks.openTeam.edit).toHaveBeenCalledWith("hub", "g1");
    await click("header:New assistant in this group");
    expect(mocks.openEditor).toHaveBeenCalledWith("hub", null, { teamId: "g1" });
    await click("header:Schedule in this group");
    expect(mocks.schedule).toHaveBeenCalledWith("hub", "g1");
    await click("header:Archive group");
    expect(mocks.archive).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    expect(byLabel("header:Restore group")).toBeNull();
  });

  it("an archived group shows the banner, restores from it or the menu, and cannot be written to", async () => {
    mocks.teams = [team({ archivedAt: "2026-11-07T09:00:00Z" })];
    render();
    expect(text()).toContain("Archived · no new messages");
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toBe("Restore the group to write here");
    expect(byLabel("Reply to Ada")?.disabled).toBe(true);
    expect(byLabel("menu:Reply")?.disabled).toBe(true);
    await click("Restore");
    expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    await click("header:Restore group");
    expect(mocks.restore).toHaveBeenCalledTimes(2);
    expect(byLabel("header:Archive group")).toBeNull();
  });
});
