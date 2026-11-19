import { RegistryProvider } from "@effect/atom-react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Request = { id: string; kind: string; createdAt: string };

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shells: [] as Array<{
      environmentId: string;
      id: string;
      title: string;
      projectId: string;
      archivedAt: null;
      pendingRequest: Request | null;
      pendingGuestMessageCount?: number;
      oldestPendingGuestMessageAt: string | null;
    }>,
    decisions: [] as Array<{ environmentId: string; decision: Record<string, unknown> }>,
    detail: {} as Record<string, unknown>,
    active: [] as Array<{
      environmentId: string;
      assistant: { id: string; name: string; threadId: string | null };
    }>,
    tasks: new Map<string, Array<{ threadId: string }>>(),
    respondToApproval: vi.fn(),
    respondToUserInput: vi.fn(),
    answer: vi.fn(),
    select: vi.fn(),
    dismissKeyboard: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode; testID?: string }) => (
    <div data-testid={props.testID}>{props.children}</div>
  ),
  Pressable: (props: { onPress?: () => void; children?: ReactNode }) => (
    <button onClick={() => props.onPress?.()}>{props.children}</button>
  ),
  Keyboard: { dismiss: mocks.dismissKeyboard },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; accessibilityRole?: string }) => (
    <span role={props.accessibilityRole}>{props.children}</span>
  ),
  AppTextInput: (props: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <s>{`symbol:${props.name}`}</s>,
}));
vi.mock("../../components/ProjectFavicon", () => ({
  ProjectFavicon: (props: { projectTitle: string }) => <em>{`fav:${props.projectTitle}`}</em>,
}));
vi.mock("../assistants/assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { name: string } }) => (
    <i>{`av:${props.assistant.name}`}</i>
  ),
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-11-06T12:00:00Z") }));
vi.mock("../../state/entities", () => ({
  useQuietThreadShells: () => mocks.shells,
  useQuietThreadShell: (ref: { threadId: string }) =>
    mocks.shells.find((shell) => shell.id === ref.threadId) ?? null,
  useProject: (ref: { projectId: string } | null) =>
    ref === null ? null : { environmentId: "hub", id: ref.projectId, title: "Website" },
}));
vi.mock("../../state/assistants", async () => {
  const { buildThreadOwnership } = await import("../../state/threadOwnership");
  const { assistantStatusOf } = await import("@t3tools/client-runtime/sidebarZones");
  const zoneShells = () =>
    mocks.shells.map((shell) => ({
      ...shell,
      lineage: { parentThreadId: null },
      delegatedFrom: null,
    }));
  const ownership = () =>
    buildThreadOwnership({
      shells: zoneShells(),
      active: mocks.active,
      activeTeams: [],
      tasksByAssistant: mocks.tasks,
    });
  return {
    useAssistantEntries: () => ({ active: mocks.active, activeTeams: [] }),
    useThreadOwnership: ownership,
    useAssistantStatus: () =>
      assistantStatusOf({
        shells: zoneShells() as never,
        decisions: mocks.decisions as never,
        ownerOf: ownership().ownerOf,
        sites: [],
        reachable: () => null,
        teams: [],
      }),
  };
});
vi.mock("../../state/decisions", () => ({
  useDecisionEntries: () => ({ open: mocks.decisions }),
  useDecisionActions: () => ({ canAct: true, answer: mocks.answer }),
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const atoms = new Map<string, unknown>();
  return {
    environmentThreadDetails: {
      // One atom per thread and fixture, as the real family keeps one per thread.
      pendingRequestsAtom: (ref: { threadId: string }) => {
        const detail = mocks.detail[ref.threadId] ?? null;
        const key = `${ref.threadId}:${JSON.stringify(detail)}`;
        if (!atoms.has(key)) atoms.set(key, Atom.make(detail));
        return atoms.get(key);
      },
    },
    threadEnvironment: { respondToApproval: "approval", respondToUserInput: "input" },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "approval" ? mocks.respondToApproval : mocks.respondToUserInput,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "hub", label: "Studio Mac" }] }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.select,
}));

import { NeedsYouZone } from "./NeedsYouZone";

const at = (minute: number) => `2026-11-06T11:${String(minute).padStart(2, "0")}:00.000Z`;
const shell = (id: string, pendingRequest: Request | null = null, title = id) => ({
  environmentId: "hub",
  id,
  title,
  projectId: "p1",
  archivedAt: null,
  pendingRequest,
  oldestPendingGuestMessageAt: null,
});
const question = (id: string, options: Array<{ label: string; value?: string }>) => ({
  id,
  header: "Q",
  question: `Question ${id}?`,
  options: options.map((option) => ({ description: "", ...option })),
  multiSelect: false,
});
const decision = (id: string, options: number, createdAt: string) => ({
  environmentId: "hub",
  decision: {
    id,
    status: "open",
    fromThreadId: "plain",
    createdAt,
    title: `Pick ${id}`,
    options: Array.from({ length: options }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })),
  },
});
const SUCCESS = { _tag: "Success", value: undefined };

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(() =>
    root.render(
      <RegistryProvider>
        <NeedsYouZone gutter={4} />
      </RegistryProvider>,
    ),
  );
const items = () => [...container.querySelectorAll('[data-testid="needs-you-item"]')];
const byLabel = (label: string, scope: ParentNode = container) =>
  scope.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const press = (label: string, scope?: ParentNode) =>
  act(async () => byLabel(label, scope)?.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  Object.assign(mocks, {
    shells: [],
    decisions: [],
    detail: {},
    active: [],
    tasks: new Map(),
  });
  for (const fn of [
    mocks.respondToApproval,
    mocks.respondToUserInput,
    mocks.answer,
    mocks.select,
    mocks.dismissKeyboard,
  ]) {
    fn.mockReset();
  }
  mocks.respondToApproval.mockResolvedValue(SUCCESS);
  mocks.respondToUserInput.mockResolvedValue(SUCCESS);
  mocks.answer.mockResolvedValue({ ok: true });
});
afterEach(() => act(() => root.unmount()));

describe("NeedsYouZone", () => {
  it("draws nothing while nothing waits on the user", async () => {
    mocks.shells = [
      shell("plain"),
      shell("bot", { id: "m", kind: "auth_refresh", createdAt: at(1) }),
    ];
    await render();
    expect(container.textContent).toBe("");
  });

  it("lists one item per approval, question, decision and waiting guest, oldest first, with origin and summary", async () => {
    mocks.active = [
      { environmentId: "hub", assistant: { id: "ada", name: "Ada", threadId: null } },
    ];
    mocks.tasks = new Map([["hub:ada", [{ threadId: "task" }]]]);
    mocks.shells = [
      shell("plain", { id: "r-approve", kind: "command", createdAt: at(2) }, "Fix login"),
      shell("task", { id: "r-ask", kind: "user_input", createdAt: at(1) }),
      {
        ...shell("shared", null, "Review me"),
        pendingGuestMessageCount: 1,
        oldestPendingGuestMessageAt: at(4),
      },
    ];
    // Its thread is not loaded here, so the card names it by the title the decision carries.
    const unloaded = decision("d1", 2, at(3));
    mocks.decisions = [
      {
        ...unloaded,
        decision: { ...unloaded.decision, fromThreadId: "gone", threadTitle: "Plan" },
      },
    ];
    mocks.detail = {
      plain: {
        approvals: [
          {
            requestId: "r-approve",
            requestKind: "command",
            createdAt: at(2),
            detail: "rm -rf build",
            responseCapability: "live",
          },
        ],
        userInputs: [],
      },
    };
    await render();
    const [ask, approve, pick, guest] = items();
    expect(items()).toHaveLength(4);
    expect(container.textContent).toContain("Needs you4");
    // An assistant's task shows the assistant; a project thread shows its title and project.
    expect(ask!.textContent).toContain("av:Ada");
    expect(ask!.textContent).toContain("Asked a question");
    expect(approve!.textContent).toContain("Fix login");
    expect(approve!.textContent).toContain("· Website · Studio Mac");
    expect(approve!.textContent).toContain("rm -rf build");
    expect(pick!.textContent).toContain("Pick d1");
    expect(pick!.textContent).toContain("Plan");
    // The guest's messages are sent or dismissed in the thread, so its item only opens it.
    expect(guest!.textContent).toContain("Review me");
    expect(guest!.textContent).toContain("Guest waiting");
    expect([...guest!.querySelectorAll("button[aria-label]")].map((b) => b.ariaLabel)).toEqual([
      "Open",
    ]);
    await press("Open", guest);
    expect(mocks.select).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "shared" },
    });
  });

  it("Approve and Deny answer that request; an error stays on the item", async () => {
    mocks.shells = [shell("plain", { id: "r1", kind: "command", createdAt: at(1) })];
    mocks.detail = {
      plain: {
        approvals: [
          { requestId: "r1", requestKind: "command", createdAt: at(1), responseCapability: "live" },
        ],
        userInputs: [],
      },
    };
    await render();
    await press("Approve");
    expect(mocks.respondToApproval).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { threadId: "plain", requestId: "r1", decision: "accept" },
    });
    mocks.respondToApproval.mockResolvedValueOnce({
      _tag: "Failure",
      cause: (await import("effect/Cause")).fail(new Error("Provider went away.")),
    });
    await press("Deny");
    expect(mocks.respondToApproval).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { threadId: "plain", requestId: "r1", decision: "decline" },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Provider went away.");
    expect(items()).toHaveLength(1);
    await press("Open");
    expect(mocks.select).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "plain" },
    });
  });

  it("answers a single question by option or typed text, and closes the keyboard after sending", async () => {
    mocks.shells = [
      shell("choose", { id: "q1", kind: "user_input", createdAt: at(1) }),
      shell("type", { id: "q2", kind: "user_input", createdAt: at(2) }),
    ];
    const input = (requestId: string, questions: unknown[]) => ({
      approvals: [],
      userInputs: [
        { requestId, createdAt: at(1), questions, responseCapability: "live", dismissible: false },
      ],
    });
    mocks.detail = {
      choose: input("q1", [question("a", [{ label: "Yes", value: "y" }, { label: "No" }])]),
      type: input("q2", [question("b", [])]),
    };
    await render();
    const [choose, type] = items();
    await press("Yes", choose);
    expect(mocks.respondToUserInput).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { threadId: "choose", requestId: "q1", answers: { a: "y" } },
    });
    await press("No", choose);
    expect(mocks.respondToUserInput).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { threadId: "choose", requestId: "q1", answers: { a: "No" } },
    });
    const field = type!.querySelector<HTMLInputElement>('[aria-label="Answer"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        field,
        "Ship it",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Send", type);
    expect(mocks.dismissKeyboard).toHaveBeenCalledOnce();
    expect(mocks.respondToUserInput).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { threadId: "type", requestId: "q2", answers: { b: "Ship it" } },
    });
  });

  it("offers Open only for several questions, a request that is not live, or many decision options", async () => {
    mocks.shells = [
      shell("many", { id: "q1", kind: "user_input", createdAt: at(1) }),
      shell("gone", { id: "r1", kind: "command", createdAt: at(2) }),
    ];
    mocks.decisions = [decision("wide", 4, at(3))];
    mocks.detail = {
      many: {
        approvals: [],
        userInputs: [
          {
            requestId: "q1",
            createdAt: at(1),
            questions: [question("a", [{ label: "A" }]), question("b", [{ label: "B" }])],
            responseCapability: "live",
            dismissible: false,
          },
        ],
      },
      gone: {
        approvals: [
          {
            requestId: "r1",
            requestKind: "command",
            createdAt: at(2),
            responseCapability: "not_resumable",
          },
        ],
        userInputs: [],
      },
    };
    await render();
    expect(items()).toHaveLength(3);
    for (const item of items()) {
      expect([...item.querySelectorAll("button[aria-label]")].map((b) => b.ariaLabel)).toEqual([
        "Open",
      ]);
    }
  });

  it("a decision option answers it; the list shows five until Show N more", async () => {
    mocks.decisions = Array.from({ length: 7 }, (_, i) => decision(`d${i}`, 2, at(i)));
    await render();
    expect(items()).toHaveLength(5);
    await press("Option 1", items()[0]);
    expect(mocks.answer).toHaveBeenCalledWith("d0", { optionId: "o1" });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Show 2 more")
        ?.click(),
    );
    expect(items()).toHaveLength(7);
  });
});
