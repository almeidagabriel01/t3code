import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ModelSelection, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi, type Mock } from "vite-plus/test";

type Command = "delete" | "forkSideChat" | "setRuntimeMode" | "startTurn";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    commands: {} as Record<Command, Mock<(input: unknown) => Promise<unknown>>>,
    alert: vi.fn(),
    open: vi.fn(),
    waitForShell: vi.fn(),
    parentRuntimeMode: "full-access" as string | null,
  },
}));

vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "side" }));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadEnvironment: {
      delete: "delete",
      forkSideChat: "forkSideChat",
      setRuntimeMode: "setRuntimeMode",
      startTurn: "startTurn",
    },
    environmentThreadShells: {
      threadShellAtom: () =>
        Atom.make(
          mocks.parentRuntimeMode === null ? null : { runtimeMode: mocks.parentRuntimeMode },
        ),
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: Command) => (input: unknown) => mocks.commands[command](input),
}));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => mocks.open }));
vi.mock("./threadForkNavigation", () => ({ waitForThreadShell: mocks.waitForShell }));

import { appAtomRegistry } from "../../state/atom-registry";
import { startingSideChatsAtom } from "../../state/starting-side-chats";
import { useStartSideChatWithPrompt } from "./useStartSideChat";

const environmentId = "env" as EnvironmentId;
const source = scopeThreadRef(environmentId, "parent" as ThreadId);
const target = { environmentId, threadId: "side" };
const modelSelection = { instanceId: "codex", model: "gpt-5.4" } as ModelSelection;
const ok = AsyncResult.success(undefined);
const starting = () => appAtomRegistry.get(startingSideChatsAtom);

function setup(parentRuntimeMode: RuntimeMode | null = "full-access") {
  appAtomRegistry.set(startingSideChatsAtom, {});
  for (const mock of [mocks.alert, mocks.open, mocks.waitForShell]) mock.mockReset();
  mocks.waitForShell.mockResolvedValue(true);
  mocks.parentRuntimeMode = parentRuntimeMode;
  mocks.commands = {
    delete: vi.fn(async () => ok),
    forkSideChat: vi.fn(async () => ok),
    setRuntimeMode: vi.fn(async () => ok),
    startTurn: vi.fn(async () => ok),
  };
  return (runtimeMode: RuntimeMode = "full-access") =>
    useStartSideChatWithPrompt()(source, "why does this fail?", { runtimeMode, modelSelection });
}

describe("useStartSideChatWithPrompt", () => {
  it("opens the side chat with its message before the server has forked it", async () => {
    const start = setup();
    const fork = Promise.withResolvers<typeof ok>();
    mocks.commands.forkSideChat = vi.fn(() => fork.promise);
    // The message stays on screen while the shell is late: a slow link gets a second wait.
    const arrived = [false, true];
    mocks.waitForShell.mockImplementation(async () => {
      expect(starting()).toEqual({ side: { prompt: "why does this fail?", error: null } });
      return arrived.shift() ?? true;
    });

    const started = start();
    expect(starting()).toEqual({ side: { prompt: "why does this fail?", error: null } });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(target);
    expect(mocks.commands.forkSideChat).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        sourceThreadId: "parent",
        targetThreadId: "side",
        title: "Side chat",
        creationSource: "mobile",
      },
    });
    expect(mocks.commands.startTurn).not.toHaveBeenCalled();

    fork.resolve(ok);
    expect(await started).toBe(true);
    expect(mocks.commands.startTurn).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: expect.objectContaining({
        threadId: "side",
        message: { messageId: "side", role: "user", text: "why does this fail?", attachments: [] },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    });
    expect(mocks.waitForShell).toHaveBeenCalledTimes(2);
    expect(mocks.waitForShell).toHaveBeenLastCalledWith(
      scopeThreadRef(environmentId, "side" as ThreadId),
    );
    expect(starting()).toEqual({});
    // A fork copies its parent's mode, so the unchanged mode is not set again.
    expect(mocks.commands.setRuntimeMode).not.toHaveBeenCalled();
    expect(mocks.commands.delete).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it.each([
    { parent: "full-access", composer: "approval-required" },
    { parent: null, composer: "full-access" },
  ] as const)(
    "sets the $composer mode on a side chat whose parent has $parent",
    async ({ parent, composer }) => {
      const start = setup(parent);
      expect(await start(composer)).toBe(true);
      expect(mocks.commands.setRuntimeMode).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: expect.objectContaining({ threadId: "side", runtimeMode: composer }),
      });
      expect(mocks.commands.startTurn).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      step: "forkSideChat",
      failure: AsyncResult.failure(Cause.fail(new Error("offline"))),
      error: "offline",
      discards: false,
      skipped: ["setRuntimeMode", "startTurn"],
    },
    {
      step: "setRuntimeMode",
      failure: AsyncResult.failure(Cause.fail("refused")),
      error: "Could not set the side chat's permission mode.",
      discards: true,
      skipped: ["startTurn"],
    },
    {
      step: "startTurn",
      failure: AsyncResult.failure(Cause.interrupt()),
      error: "Could not send the side chat message.",
      discards: true,
      skipped: [],
    },
  ] as const)(
    "shows why the side chat did not start when $step fails",
    async ({ step, failure, error, discards, skipped }) => {
      const start = setup();
      mocks.commands[step] = vi.fn(async () => failure);

      expect(await start("approval-required")).toBe(false);
      expect(starting()).toEqual({ side: { prompt: "why does this fail?", error } });
      for (const command of skipped) expect(mocks.commands[command]).not.toHaveBeenCalled();
      expect(mocks.commands.delete.mock.calls).toEqual(
        discards ? [[{ environmentId, input: { threadId: "side", onlyIfUnused: true } }]] : [],
      );
      // The screen that opened carries the error: no alert and no second navigation.
      expect(mocks.open).toHaveBeenCalledExactlyOnceWith(target);
      expect(mocks.alert).not.toHaveBeenCalled();
      expect(mocks.waitForShell).not.toHaveBeenCalled();
    },
  );
});
