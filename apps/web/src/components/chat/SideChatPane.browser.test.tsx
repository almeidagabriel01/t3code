import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  commands: {} as Record<string, ReturnType<typeof import("vite-plus/test").vi.fn>>,
  confirm: undefined as unknown as ReturnType<typeof import("vite-plus/test").vi.fn>,
  parent: {} as Record<string, unknown>,
  confirmThreadDelete: true,
}));

vi.mock(import("../ChatView"), () => ({ default: (() => null) as never }));
vi.mock(import("../../state/entities"), () => ({
  useQuietThreadShell: ((ref: { threadId: string }) =>
    ref.threadId === "parent" ? mocks.parent : { title: "Quick question" }) as never,
  useQuietThreadProjection: (() => null) as never,
  waitForThreadShell: (async () => true) as never,
}));
vi.mock(import("../../state/session"), () => ({ useEnvironmentScope: (() => true) as never }));
vi.mock(import("../../state/shell"), () => ({
  useEnvironmentShellHasSnapshot: (() => true) as never,
}));
vi.mock(import("../../state/threads"), () => ({
  threadEnvironment: {
    mergeBack: "mergeBack",
    delete: "delete",
    updateMetadata: "updateMetadata",
    forkSideChat: "forkSideChat",
    startTurn: "startTurn",
  } as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: string) => mocks.commands[command]) as never,
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => vi.fn()) as never,
}));
vi.mock(import("../../hooks/useSettings"), () => ({
  useClientSettings: (() => mocks.confirmThreadDelete) as never,
}));
vi.mock(import("../../localApi"), () => ({
  readLocalApi: (() => ({ dialogs: { confirm: mocks.confirm } })) as never,
}));

import { render } from "../../../test/render";
import { useRightPanelStore } from "../../rightPanelStore";
import SideChatPane from "./SideChatPane";

const environmentId = EnvironmentId.make("environment");
const parentRef = scopeThreadRef(environmentId, ThreadId.make("parent"));
const threadId = ThreadId.make("side-old");

function setup(parent: Record<string, unknown>, confirmed = true) {
  mocks.parent = {
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    goal: null,
    ...parent,
  };
  mocks.confirmThreadDelete = true;
  mocks.confirm = vi.fn(async () => confirmed);
  for (const key of ["mergeBack", "delete", "updateMetadata", "forkSideChat"]) {
    mocks.commands[key] = vi.fn(async () => AsyncResult.success(undefined));
  }
  useRightPanelStore.getState().openSideChat(parentRef, threadId);
}

const pane = () => (
  <SideChatPane
    parentRef={parentRef}
    threadId={threadId}
    parentPanel={{ openToolDiff: vi.fn(), runShellCommand: vi.fn(), sendToComposer: vi.fn() }}
    onClose={vi.fn()}
  />
);

const surfaceIds = () =>
  useRightPanelStore.getState().byThreadKey[`${environmentId}:parent`]?.surfaces.map((s) => s.id);

it("shows what the main thread is doing", async () => {
  setup({ hasPendingApprovals: true });
  await using screen = await render(pane());
  await expect
    .element(screen.getByRole("status"))
    .toHaveAttribute("data-side-chat-parent-status", "attention");
  await expect
    .element(screen.getByRole("status"))
    .toHaveAccessibleName("Main thread: Needs approval");
});

it("starts over: opens a fresh side chat, then deletes this one and closes its tab", async () => {
  setup({});
  await using screen = await render(pane());
  await screen.getByRole("button", { name: "Start over" }).click();
  await vi.waitFor(() =>
    expect(mocks.commands.delete).toHaveBeenCalledWith({
      environmentId,
      input: { threadId },
    }),
  );
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.commands.forkSideChat).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ sourceThreadId: "parent" }),
  });
  const ids = surfaceIds() ?? [];
  expect(ids).not.toContain(`side-chat:${threadId}`);
  expect(ids.filter((id) => id.startsWith("side-chat:"))).toHaveLength(1);
});

it("leaves the side chat alone when start over is not confirmed", async () => {
  setup({}, false);
  await using screen = await render(pane());
  await screen.getByRole("button", { name: "Start over" }).click();
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(mocks.commands.forkSideChat).not.toHaveBeenCalled();
  expect(mocks.commands.delete).not.toHaveBeenCalled();
});

it("keeps this side chat when the fresh one cannot start", async () => {
  setup({});
  mocks.commands.forkSideChat = vi.fn(async () => AsyncResult.failure(Cause.fail(new Error("no"))));
  await using screen = await render(pane());
  await screen.getByRole("button", { name: "Start over" }).click();
  await vi.waitFor(() => expect(mocks.commands.forkSideChat).toHaveBeenCalled());
  expect(mocks.commands.delete).not.toHaveBeenCalled();
});

it("turns into a thread and asks for a new title", async () => {
  setup({});
  await using screen = await render(pane(), { router: "/" });
  await screen.getByRole("button", { name: "Turn into thread" }).click();
  await vi.waitFor(() =>
    expect(mocks.commands.updateMetadata).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, detachSideChat: true, regenerateTitle: true },
    }),
  );
});
