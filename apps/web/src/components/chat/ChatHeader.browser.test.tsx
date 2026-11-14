import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
const openMenu = vi.hoisted(() => vi.fn());
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu, closeMenu: () => {} }),
}));
const threadAssistant = vi.hoisted(() => ({
  entry: null as unknown,
  taskOwner: null as unknown,
  messages: [] as ReadonlyArray<{ id: string; senderThreadId?: string }>,
}));
vi.mock(import("../../state/assistants"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadAssistant: (() => threadAssistant.entry) as never,
  useTaskAssistant: (() => threadAssistant.taskOwner) as never,
  useAssistantEntries: (() => ({
    active: threadAssistant.taskOwner === null ? [] : [threadAssistant.taskOwner],
    archived: [],
    environmentIds: [],
  })) as never,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    useQuietThreadProjection: ((ref: Parameters<typeof original.useQuietThreadProjection>[0]) => {
      const real = original.useQuietThreadProjection(ref);
      return threadAssistant.messages.length === 0
        ? real
        : { projection: { thread: {}, messages: threadAssistant.messages } };
    }) as never,
  };
});

import { render, stubGlobal } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assistantInfoAtom, closeAssistantInfo } from "../assistants/assistantInfoState";
import { ChatHeader } from "./ChatHeader";

function header(title: string) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("an assistant chat's name toggles Assistant info; ⋯ and right-click open the thread menu", async () => {
  openMenu.mockClear();
  closeAssistantInfo();
  using _entry = {
    [Symbol.dispose]: () => {
      threadAssistant.entry = null;
    },
  };
  threadAssistant.entry = {
    environmentId: EnvironmentId.make("environment"),
    assistant: { id: "jarvis", name: "Jarvis", avatar: null, icon: null },
  };
  await using screen = await render(header("assistant thread"));
  const name = screen.getByRole("button", { name: "Jarvis, Assistant info" });
  await name.click();
  expect(appAtomRegistry.get(assistantInfoAtom)).toEqual({
    kind: "assistant",
    environmentId: "environment",
    assistantId: "jarvis",
  });
  await name.click();
  expect(appAtomRegistry.get(assistantInfoAtom)).toBeNull();
  expect(openMenu).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Thread actions for Jarvis" }).click();
  expect(openMenu).toHaveBeenCalledOnce();
  await name.click({ button: "right" });
  expect(openMenu).toHaveBeenCalledTimes(2);
  expect(appAtomRegistry.get(assistantInfoAtom)).toBeNull();
});

it("opens the thread menu on a desktop title click without waiting", async () => {
  openMenu.mockClear();
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(header("New thread"));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).click();
  expect(openMenu).toHaveBeenCalledOnce();
});

it("a task thread its own assistant wrote in shows one assistant control", async () => {
  using _task = {
    [Symbol.dispose]: () => {
      threadAssistant.taskOwner = null;
      threadAssistant.messages = [];
    },
  };
  threadAssistant.taskOwner = {
    environmentId: EnvironmentId.make("environment"),
    assistant: {
      id: "qa",
      name: "QA",
      avatar: null,
      icon: null,
      toolAccess: "edit",
      askBeforeActing: false,
      threadId: ThreadId.make("assistant:qa:1"),
    },
  };
  threadAssistant.messages = [
    { id: "m1", senderThreadId: "assistant:qa:1" },
    { id: "m2", senderThreadId: "assistant:qa:1" },
  ];
  await using screen = await render(header("go"));
  await expect
    .element(screen.getByRole("button", { name: "Assistants in this thread: 1" }))
    .toBeInTheDocument();
  const assistantControls = [
    ...screen.container.querySelectorAll<HTMLElement>("button[aria-label]"),
  ].filter((button) => /QA|Assistants in this thread/.test(button.getAttribute("aria-label")!));
  expect(assistantControls).toHaveLength(1);
});
