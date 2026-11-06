import { EnvironmentId, ThreadId, type Assistant } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  messages: [] as ReadonlyArray<{ id: string; senderThreadId?: string }>,
  assistants: [] as ReadonlyArray<unknown>,
  running: false,
  update: vi.fn(async (_input: unknown) => ({ ok: true as const, value: undefined })),
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadProjection: (() => ({ projection: { messages: state.messages } })) as never,
  useQuietThreadShell: (() => ({
    runtime: { status: state.running ? "running" : "idle" },
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
}));

import { render } from "../../../test/render";
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
    threadId: ThreadId.make(`assistant:${id}:1`),
  };
}

function setup(running: boolean) {
  state.running = running;
  state.update.mockClear();
  state.assistants = [assistant("jarvis", "Jarvis", "full"), assistant("owl", "Owl", "read-only")];
  state.messages = [
    { id: "m1", senderThreadId: "assistant:jarvis:1" },
    { id: "m2" },
    { id: "m3", senderThreadId: "assistant:owl:1" },
    { id: "m4", senderThreadId: "assistant:jarvis:1" },
  ];
}

it("lists the assistants that wrote here, saves their access and jumps to their last message", async () => {
  setup(true);
  const jumpToMessage = vi.fn();
  using _detach = {
    [Symbol.dispose]: attachTimelineJump({ threadKey: "environment:thread", jumpToMessage }),
  };
  await using screen = await render(
    <div className="@container/header w-[800px]">
      <AssistantPresenceStack environmentId={ENVIRONMENT_ID} threadId={THREAD_ID} />
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "Assistants in this thread: 2" });
  await expect.element(trigger).toBeVisible();
  expect(screen.container.querySelector('[data-assistant-status="working"]')).not.toBeNull();

  await trigger.click();
  await expect.element(page.getByText("Working · 2 messages here")).toBeVisible();
  await expect
    .element(page.getByText("Working · 1 message here · Asks before acting"))
    .toBeVisible();

  await page.getByRole("combobox", { name: "Access for Owl" }).click();
  await page.getByRole("option", { name: "Full access" }).click();
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith({ assistantId: "owl", toolAccess: "full" }),
  );

  await page.getByRole("button", { name: "Jump to Jarvis's last message" }).click();
  expect(jumpToMessage).toHaveBeenCalledWith("m4");
});

it("renders nothing when no assistant wrote in the thread", async () => {
  setup(false);
  state.messages = [{ id: "m1" }];
  await using screen = await render(
    <AssistantPresenceStack environmentId={ENVIRONMENT_ID} threadId={THREAD_ID} />,
  );
  expect(screen.container.textContent).toBe("");
  expect(screen.container.querySelector("button")).toBeNull();
});
