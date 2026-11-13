import { EnvironmentId, ThreadId, type Assistant } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  messages: [] as ReadonlyArray<{ id: string; senderThreadId?: string }>,
  assistants: [] as ReadonlyArray<unknown>,
  working: new Set<string>(),
  update: vi.fn(async (_input: unknown) => ({ ok: true as const, value: undefined })),
  owner: null as unknown,
  taskShell: null as unknown,
  task: null as null | { dismissedAt: string | null },
  flows: { openConversation: vi.fn(), dismissTask: vi.fn(), restoreTask: vi.fn() },
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadProjection: (() => ({ projection: { messages: state.messages } })) as never,
  useQuietThreadShells: (() => []) as never,
  useThreadShell: (() => state.taskShell) as never,
}));
vi.mock(import("@t3tools/client-runtime/assistantRobot"), async (importOriginal) => ({
  ...(await importOriginal()),
  assistantPresenceOf: ((assistant: { id: string } | null) => ({
    mood: assistant && state.working.has(assistant.id) ? "working" : "idle",
    detail: "",
    since: null,
    reading: false,
    queued: 0,
  })) as never,
}));
vi.mock(import("../../state/assistants"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssistantEntries: (() => ({
    active: state.assistants.map((assistant) => ({
      environmentId: EnvironmentId.make("environment"),
      assistant,
    })),
    archived: [],
    environmentIds: [],
  })) as never,
  useAssistantActions: (() => ({ canAct: true, update: state.update })) as never,
  useTaskAssistant: (() => state.owner) as never,
  useAssistantTask: (() => state.task) as never,
}));
vi.mock(import("../assistants/useAssistantFlows"), () => ({
  useAssistantFlows: (() => ({ canAct: true, ...state.flows })) as never,
}));

import { render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assistantInfoAtom, closeAssistantInfo } from "../assistants/assistantInfoState";
import { AssistantPresenceStack } from "./AssistantPresenceStack";
import { attachTimelineJump } from "./timelineJump";

const ENVIRONMENT_ID = EnvironmentId.make("environment");
const THREAD_ID = ThreadId.make("thread");

function assistant(id: string, name: string, toolAccess: Assistant["toolAccess"]) {
  return {
    id,
    name,
    handle: id,
    toolAccess,
    askBeforeActing: id === "owl",
    icon: id === "owl" ? "scout" : null,
    avatar: null,
    threadId: ThreadId.make(`assistant:${id}:1`),
  };
}

function setup() {
  closeAssistantInfo();
  state.update.mockClear();
  state.owner = null;
  state.taskShell = null;
  state.task = null;
  for (const fn of Object.values(state.flows)) fn.mockClear();
  state.working = new Set(["jarvis"]);
  state.assistants = [assistant("jarvis", "Jarvis", "full"), assistant("owl", "Owl", "read-only")];
  state.messages = [
    { id: "m1", senderThreadId: "assistant:owl:1" },
    { id: "m2" },
    { id: "m3", senderThreadId: "assistant:jarvis:1" },
    { id: "m4", senderThreadId: "assistant:jarvis:1" },
  ];
}

const renderStack = () =>
  render(
    <div className="@container/header w-[800px]">
      <AssistantPresenceStack environmentId={ENVIRONMENT_ID} threadId={THREAD_ID} />
    </div>,
  );

it("groups the assistants into Working and Idle, each on one status line", async () => {
  setup();
  await page.viewport(320, 640);
  await using screen = await renderStack();
  const trigger = screen.getByRole("button", { name: "Assistants in this thread: 2" });
  await expect.element(trigger).toBeVisible();
  expect(
    screen.container
      .querySelector("[data-assistant-cluster]")
      ?.getAttribute("data-assistant-cluster"),
  ).toBe("2");

  await trigger.click();
  await expect.element(page.getByText("Assistants in this thread · 2")).toBeVisible();
  const working = page.getByRole("region", { name: "Working" });
  const idle = page.getByRole("region", { name: "Idle" });
  await expect.element(working.getByText("Working · 2 messages here")).toBeVisible();
  await expect.element(idle.getByText("Idle · 1 message here · Asks before acting")).toBeVisible();
  expect(working.getByText("Owl").query()).toBeNull();

  for (const status of document.querySelectorAll<HTMLElement>("[data-assistant-presence-status]")) {
    const fontSize = Number.parseFloat(getComputedStyle(status).fontSize);
    expect(status.getBoundingClientRect().height).toBeLessThan(fontSize * 2);
  }
});

it("an idle-only thread draws no Working section", async () => {
  setup();
  state.working = new Set();
  await using screen = await renderStack();
  await screen.getByRole("button", { name: "Assistants in this thread: 2" }).click();
  await expect.element(page.getByRole("region", { name: "Idle" })).toBeVisible();
  expect(page.getByRole("region", { name: "Working" }).query()).toBeNull();
});

it("the row menu saves access and opens info; the row and jump button work too", async () => {
  setup();
  const jumpToMessage = vi.fn();
  using _detach = {
    [Symbol.dispose]: attachTimelineJump({ threadKey: "environment:thread", jumpToMessage }),
  };
  await using screen = await renderStack();
  const trigger = screen.getByRole("button", { name: "Assistants in this thread: 2" });

  await trigger.click();
  await page.getByRole("button", { name: "Owl actions" }).click();
  await page.getByRole("menuitem", { name: "Access" }).click();
  await page.getByRole("menuitemradio", { name: "Full access" }).click();
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith({ assistantId: "owl", toolAccess: "full" }),
  );

  await page.getByRole("button", { name: "Owl actions" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Open chat" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Assistant info" }).click();
  expect(appAtomRegistry.get(assistantInfoAtom)).toEqual({
    kind: "assistant",
    environmentId: ENVIRONMENT_ID,
    assistantId: "owl",
  });

  await trigger.click();
  await page.getByRole("button", { name: "Jarvis, Assistant info" }).click();
  expect(appAtomRegistry.get(assistantInfoAtom)).toMatchObject({ assistantId: "jarvis" });

  await trigger.click();
  await page.getByRole("button", { name: "Jump to Jarvis's last message" }).click();
  expect(jumpToMessage).toHaveBeenCalledWith("m4");
});

it("renders nothing when no assistant wrote in the thread", async () => {
  setup();
  state.messages = [{ id: "m1" }];
  await using screen = await render(
    <AssistantPresenceStack environmentId={ENVIRONMENT_ID} threadId={THREAD_ID} />,
  );
  expect(screen.container.textContent).toBe("");
  expect(screen.container.querySelector("button")).toBeNull();
});

it("the assistant that launched the thread joins the one control in the task's mood, with the task's actions", async () => {
  setup();
  const jarvis = state.assistants[0] as ReturnType<typeof assistant>;
  state.owner = { environmentId: ENVIRONMENT_ID, assistant: jarvis };
  state.task = { dismissedAt: null };
  state.messages = [];
  await using screen = await renderStack();
  const trigger = screen.getByRole("button", { name: "Assistants in this thread: 1" });
  await trigger.click();
  await expect
    .element(
      page
        .getByRole("region", { name: "Working" })
        .getByRole("button", { name: "Jarvis, Assistant info" }),
    )
    .toBeVisible();
  expect(document.querySelector("[data-assistant-presence-status]")?.textContent).toBe("Working");
  expect(page.getByRole("button", { name: "Jump to Jarvis's last message" }).query()).toBeNull();
  await page.getByRole("button", { name: "Jarvis actions" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Dismiss task" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Open chat" }).click();
  expect(state.flows.openConversation).toHaveBeenCalledWith(jarvis);

  state.messages = [{ id: "m1", senderThreadId: "assistant:jarvis:1" }];
  state.taskShell = {
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
  await screen.rerender(
    <div className="@container/header w-[800px]">
      <AssistantPresenceStack environmentId={ENVIRONMENT_ID} threadId={THREAD_ID} />
    </div>,
  );
  await trigger.click();
  await expect
    .element(page.getByRole("region", { name: "Idle" }).getByText("Idle · 1 message here"))
    .toBeVisible();
  await page.getByRole("button", { name: "Jarvis actions" }).click();
  await page.getByRole("menuitem", { name: "Dismiss task" }).click();
  expect(state.flows.dismissTask).toHaveBeenCalledWith(THREAD_ID);

  state.task = { dismissedAt: "2026-11-06T00:00:00.000Z" };
  await screen.rerender(
    <div className="@container/header w-[800px]">
      <AssistantPresenceStack environmentId={ENVIRONMENT_ID} threadId={THREAD_ID} />
    </div>,
  );
  await page.getByRole("button", { name: "Jarvis actions" }).click();
  await page.getByRole("menuitem", { name: "Restore task" }).click();
  expect(state.flows.restoreTask).toHaveBeenCalledWith(THREAD_ID);
});
