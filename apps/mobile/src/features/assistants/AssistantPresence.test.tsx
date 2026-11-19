import type { MenuAction } from "@react-native-menu/menu";
import type { AssistantSender } from "@t3tools/client-runtime/assistantPresence";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  working: new Set<string>(),
  needs: new Set<string>(),
  assistants: [] as unknown[],
  canAct: true,
  update: vi.fn(),
  alert: vi.fn(),
  jump: vi.fn(),
  openChat: vi.fn(),
  navigate: vi.fn(),
  owner: null as unknown,
  taskShell: null as unknown,
  task: null as null | { dismissedAt: string | null },
  dismissTask: vi.fn(),
  restoreTask: vi.fn(),
  openLinked: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    accessibilityLabel?: string;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: ReactNode }) => <div>{props.children}</div> },
  LinearTransition: { duration: () => ({ reduceMotion: () => ({}) }) },
  ReduceMotion: { System: "system" },
}));
vi.mock("../threads/useOpenLinkedThread", () => ({ useOpenLinkedThread: () => mocks.openLinked }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
const leaves = (actions: ReadonlyArray<MenuAction>): MenuAction[] =>
  actions.flatMap((action) => (action.subactions ? leaves(action.subactions) : [action]));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    title: string;
    actions: MenuAction[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => {
    return (
      <section aria-label={props.title}>
        {props.children}
        {leaves(props.actions).map((action) => (
          <button
            key={action.id}
            aria-label={`menu:${action.id}`}
            data-subtitle={action.subtitle}
            disabled={action.attributes?.disabled}
            onClick={() => props.onPressAction({ nativeEvent: { event: action.id ?? "" } })}
          />
        ))}
      </section>
    );
  },
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("./useUsageLimitLabel", () => ({
  useUsageLimitLabel: () => (resetAt: string | null | undefined) =>
    resetAt == null ? null : `Limit until <${resetAt}>`,
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: mocks.assistants.map((assistant) => ({ environmentId: "hub", assistant })),
    archived: [],
  }),
  useAssistantActions: () => ({ canAct: mocks.canAct, update: mocks.update }),
  useTaskAssistant: () => mocks.owner,
  useAssistantTask: () => mocks.task,
  useAssistantStatus: () => ({
    of: (_environmentId: string, assistant: { id: string } | null) => ({
      mood: !assistant
        ? "idle"
        : mocks.needs.has(assistant.id)
          ? "needs"
          : mocks.working.has(assistant.id)
            ? "working"
            : "idle",
      detail: "",
      since: null,
      reading: false,
      queued: 0,
    }),
  }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => mocks.taskShell,
}));
vi.mock("../../lib/scopedEntities", () => ({
  scopedThreadKey: (environmentId: string, threadId: string) => `${environmentId}:${threadId}`,
}));
vi.mock("../threads/threadMessageJump", () => ({ requestThreadMessageJump: mocks.jump }));
vi.mock("./assistantPresentation", () => ({
  TOOL_ACCESS_OPTIONS: [
    { value: "read-only", label: "Read only" },
    { value: "full", label: "Full access" },
  ],
  toolAccessLabel: (access: string) => access,
  removedAssistantFace: (id: string) => ({ id, avatar: null, icon: null }),
  AssistantAvatar: (props: { assistant: { id: string } }) => <i>{`av:${props.assistant.id}`}</i>,
  AssistantCluster: (props: { faces: Array<{ key: string; mood?: string }> }) => (
    <i data-testid="cluster">{props.faces.map((face) => `${face.key}:${face.mood}`).join(",")}</i>
  ),
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({
    openConversation: mocks.openChat,
    dismissTask: mocks.dismissTask,
    restoreTask: mocks.restoreTask,
  }),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));

import {
  AssistantFeedMessage,
  presenceMenuActions,
  ThreadAssistantStack,
} from "./AssistantPresence";

const assistant = (id: string, name: string, extra: object = {}) => ({
  id,
  name,
  toolAccess: "read-only",
  askBeforeActing: false,
  avatar: null,
  icon: null,
  threadId: `assistant:${id}:1`,
  ...extra,
});
const sender = (id: string, count: number, extra: object = {}): AssistantSender => ({
  assistantId: id,
  assistant: assistant(id, id.toUpperCase(), extra) as never,
  count,
  firstMessageId: `first-${id}`,
  lastMessageId: `last-${id}`,
});
const mood = (working: string[], needs: string[] = []) =>
  new Map(
    ["ada", "bo", "cy"].map((id) => [
      id,
      needs.includes(id)
        ? { face: "waiting" as const, section: "needs" as const }
        : working.includes(id)
          ? { face: "working" as const, section: "working" as const }
          : { face: "idle" as const, section: "idle" as const },
    ]),
  );
const tree = (actions: ReadonlyArray<MenuAction>): unknown[] =>
  actions.map((action) =>
    action.displayInline && action.id?.startsWith("section:")
      ? { [action.title]: tree(action.subactions ?? []) }
      : `${action.title} — ${action.subtitle}`,
  );

describe("presenceMenuActions", () => {
  const senders = [sender("ada", 1), sender("bo", 3, { askBeforeActing: true }), sender("cy", 2)];
  // Rows keep one line: "Asks before acting" stays on the message badge ("asks first").
  it.each([
    {
      name: "iOS: Needs you, Working, then Idle as titled sections",
      working: ["bo"],
      needs: ["cy"],
      inline: true,
      expected: [
        { "Needs you": ["CY — Needs you · 2 messages here"] },
        { Working: ["BO — Working · 3 messages here"] },
        { Idle: ["ADA — Idle · 1 message here"] },
      ],
    },
    {
      name: "iOS: an empty section is left out",
      working: [],
      needs: [],
      inline: true,
      expected: [
        {
          Idle: [
            "ADA — Idle · 1 message here",
            "BO — Idle · 3 messages here",
            "CY — Idle · 2 messages here",
          ],
        },
      ],
    },
    {
      name: "Android: the same order, flat",
      working: ["cy", "ada"],
      needs: ["bo"],
      inline: false,
      expected: [
        "BO — Needs you · 3 messages here",
        "ADA — Working · 1 message here",
        "CY — Working · 2 messages here",
      ],
    },
  ])("$name", ({ working, needs, inline, expected }) => {
    expect(tree(presenceMenuActions(senders, mood(working, needs), true, null, inline))).toEqual(
      expected,
    );
  });

  it.each([
    {
      name: "iOS",
      inline: true,
      expected: [{ Working: ["JARVIS — Working"] }, { Idle: ["ADA — Idle · 1 message here"] }],
    },
    {
      name: "Android",
      inline: false,
      expected: ["JARVIS — Working", "ADA — Idle · 1 message here"],
    },
  ])(
    "$name: the task's assistant with no message here has no jump, and its row dismisses the task",
    ({ inline, expected }) => {
      const owner = { ...sender("jarvis", 0), firstMessageId: "", lastMessageId: "" };
      const looks = new Map([
        ["jarvis", { face: "working" as const, section: "working" as const }],
        ["ada", { face: "idle" as const, section: "idle" as const }],
      ]);
      const task = { assistantId: "jarvis", state: "running" as const, dismissed: false };
      const actions = presenceMenuActions([owner, sender("ada", 1)], looks, true, task, inline);
      expect(tree(actions)).toEqual(expected);
      const rows = actions.flatMap((action) => (inline ? (action.subactions ?? []) : [action]));
      expect(rows.map((row) => row.subactions?.map((item) => item.title))).toEqual([
        ["Access", "Open chat", "Assistant info", "Dismiss task"],
        ["Jump to last message", "Access", "Open chat", "Assistant info"],
      ]);
    },
  );

  it("a removed assistant can only be jumped to; access follows the permission", () => {
    const removed = { ...sender("gone", 1), assistant: null };
    const [row] = presenceMenuActions([removed], new Map(), true, null, false);
    expect(row?.title).toBe("Assistant");
    expect(row?.subactions?.map((action) => action.title)).toEqual(["Jump to last message"]);
    const [locked] = presenceMenuActions([sender("ada", 1)], mood([]), false, null, false);
    const access = locked?.subactions?.find((action) => action.title === "Access");
    expect(access?.subactions?.map((option) => [option.title, option.state])).toEqual([
      ["Read only", "on"],
      ["Full access", "off"],
    ]);
    expect(access?.subactions?.every((option) => option.attributes?.disabled)).toBe(true);
  });
});

const mount = (node: ReactNode) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    rerender: (next: ReactNode) => act(() => root.render(next)),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
};

describe("ThreadAssistantStack", () => {
  const messages = [
    { id: "m1", senderThreadId: "assistant:ada:1" },
    { id: "m2", senderThreadId: "assistant:bo:1" },
  ] as never;

  it("shows one cluster and routes each menu entry", async () => {
    mocks.assistants = [assistant("ada", "Ada"), assistant("bo", "Bo")];
    mocks.working = new Set(["bo"]);
    mocks.update.mockReset().mockResolvedValue({ ok: false, message: "No permission" });
    for (const fn of [mocks.alert, mocks.jump, mocks.openChat, mocks.navigate]) fn.mockReset();
    using view = mount(
      <ThreadAssistantStack
        environmentId={"hub" as never}
        threadId={"t1" as never}
        messages={messages}
      />,
    );
    const press = (id: string) =>
      act(async () =>
        view.container.querySelector<HTMLButtonElement>(`[aria-label="menu:${id}"]`)?.click(),
      );
    expect(view.container.querySelector("section")?.getAttribute("aria-label")).toBe(
      "Assistants in this thread · 2",
    );
    expect(view.container.querySelector('[data-testid="cluster"]')?.textContent).toBe(
      "ada:idle,bo:working",
    );

    await press("jump:bo");
    expect(mocks.jump).toHaveBeenCalledWith("hub:t1", "m2");
    await press("access:ada|full");
    expect(mocks.update).toHaveBeenCalledWith({ assistantId: "ada", toolAccess: "full" });
    expect(mocks.alert).toHaveBeenCalledWith("Could not change access", "No permission");
    await press("chat:ada");
    expect(mocks.openChat).toHaveBeenCalledWith(expect.objectContaining({ id: "ada" }));
    await press("info:bo");
    expect(mocks.navigate).toHaveBeenCalledWith("AssistantInfo", {
      environmentId: "hub",
      assistantId: "bo",
    });
  });

  const failedShell = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    queuedMessageCount: 0,
    blockedOnThreadWait: false,
    latestRun: null,
    runtime: { status: "failed" },
    source: { latestVisibleMessage: null },
  };
  it("the task's assistant joins the cluster first, in its shared status, with its actions", async () => {
    mocks.assistants = [assistant("ada", "Ada"), assistant("jarvis", "Jarvis")];
    mocks.working = new Set(["jarvis"]);
    mocks.owner = { environmentId: "hub", assistant: mocks.assistants[1] };
    mocks.taskShell = null;
    mocks.task = { dismissedAt: null };
    for (const fn of [mocks.openChat, mocks.dismissTask, mocks.restoreTask]) fn.mockReset();
    using _reset = {
      [Symbol.dispose]: () => {
        mocks.owner = null;
        mocks.task = null;
        mocks.taskShell = null;
      },
    };
    const stack = () => (
      <ThreadAssistantStack
        environmentId={"hub" as never}
        threadId={"t1" as never}
        messages={[{ id: "m1", senderThreadId: "assistant:ada:1" }] as never}
      />
    );
    using view = mount(stack());
    const button = (id: string) =>
      view.container.querySelector<HTMLButtonElement>(`[aria-label="menu:${id}"]`);
    const cluster = () => view.container.querySelector('[data-testid="cluster"]')?.textContent;

    expect(cluster()).toBe("jarvis:working,ada:idle");
    expect(button("jump:jarvis")).toBeNull();
    expect(button("task:dismiss")?.disabled).toBe(true);
    await act(async () => button("chat:jarvis")?.click());
    expect(mocks.openChat).toHaveBeenCalledWith(expect.objectContaining({ id: "jarvis" }));

    mocks.taskShell = failedShell;
    mocks.working = new Set();
    view.rerender(stack());
    expect(cluster()).toBe("jarvis:idle,ada:idle");
    expect(button("task:dismiss")?.dataset.subtitle).toBeUndefined();
    await act(async () => button("task:dismiss")?.click());
    expect(mocks.dismissTask).toHaveBeenCalledWith("t1");

    mocks.taskShell = {
      ...failedShell,
      runtime: { status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: "2099-01-01" },
    };
    view.rerender(stack());
    expect(button("task:dismiss")?.dataset.subtitle).toBe("Limit until <2099-01-01>");
    expect(button("task:dismiss")?.disabled).toBe(false);

    mocks.task = { dismissedAt: "2026-11-06T00:00:00.000Z" };
    view.rerender(stack());
    expect(button("task:dismiss")).toBeNull();
    await act(async () => button("task:restore")?.click());
    expect(mocks.restoreTask).toHaveBeenCalledWith("t1");
  });

  it("draws nothing in an assistant's own chat", () => {
    mocks.assistants = [assistant("ada", "Ada")];
    using view = mount(
      <ThreadAssistantStack
        environmentId={"hub" as never}
        threadId={"assistant:ada:1" as never}
        messages={messages}
      />,
    );
    expect(view.container.innerHTML).toBe("");
  });
});

it("a removed assistant's message keeps a face and falls back to Assistant", () => {
  mocks.assistants = [];
  using view = mount(
    <AssistantFeedMessage environmentId={"hub" as never} assistantId="gone" joinedAtLabel="today">
      hello
    </AssistantFeedMessage>,
  );
  expect(view.container.textContent).toContain("av:gone");
  expect(view.container.textContent).toContain("Assistant joined the conversation · today");
});

it("a teammate's message shows its role, status, thread and folds when long", () => {
  mocks.assistants = [assistant("lead", "Pessoal Lead", { role: "Tech Lead" })];
  using view = mount(
    <AssistantFeedMessage
      environmentId={"hub" as never}
      assistantId="lead"
      joinedAtLabel={null}
      status="partial"
      threadId="assistant:lead:1"
      timestampLabel="6:43 PM"
      long
    >
      body
    </AssistantFeedMessage>,
  );
  const text = () => view.container.textContent ?? "";
  expect(text()).toContain("Pessoal Lead");
  expect(text()).toContain("Tech Lead · read-only");
  expect(text()).toContain("Partial");
  expect(text()).toContain("6:43 PM");
  const button = (label: string) =>
    [...view.container.querySelectorAll("button")].find((each) => each.textContent === label)!;
  act(() => button("Show more").click());
  expect(text()).toContain("Show less");
  act(() => button("Open thread").click());
  expect(mocks.openLinked).toHaveBeenCalledWith({
    environmentId: "hub",
    threadId: "assistant:lead:1",
  });
});

it("a message continuing the same teammate shows its face and name once", () => {
  mocks.assistants = [assistant("lead", "Pessoal Lead")];
  using view = mount(
    <AssistantFeedMessage
      environmentId={"hub" as never}
      assistantId="lead"
      joinedAtLabel={null}
      continues
    >
      again
    </AssistantFeedMessage>,
  );
  expect(view.container.textContent).toBe("again");
});

it("a continuing message still shows its own status", () => {
  mocks.assistants = [assistant("lead", "Pessoal Lead")];
  using view = mount(
    <AssistantFeedMessage
      environmentId={"hub" as never}
      assistantId="lead"
      joinedAtLabel={null}
      status="blocked"
      continues
    >
      again
    </AssistantFeedMessage>,
  );
  expect(view.container.textContent).toBe("Blockedagain");
});
