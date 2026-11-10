import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    commands: {} as Record<string, ReturnType<typeof vi.fn>>,
    alert: vi.fn(),
    confirm: vi.fn(),
    open: vi.fn(),
    parent: null as unknown,
    ready: true,
  },
}));

vi.mock("react-native", () => ({
  Pressable: (props: {
    children: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  View: (props: { children?: ReactNode; accessibilityLabel?: string }) => (
    <div aria-label={props.accessibilityLabel}>{props.children}</div>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert, confirm: mocks.confirm }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "new-side" }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { error: unknown }) => result.error,
}));
vi.mock("../../state/entities", () => ({ useQuietThreadShell: () => mocks.parent }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { delete: "delete", forkSideChat: "forkSideChat" },
  environmentThreadShells: { threadShellAtom: () => "shell" },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => null } }));
vi.mock("./threadForkNavigation", () => ({
  waitForThreadShell: async () => mocks.ready,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => mocks.commands[command],
}));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => mocks.open }));

import { ThreadSideChatBar } from "./ThreadSideChatBar";

const environmentId = "env" as EnvironmentId;

async function mount(canOperate = true) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ThreadSideChatBar
        environmentId={environmentId}
        threadId={"side-old" as ThreadId}
        parentThreadId={"parent" as ThreadId}
        canOperate={canOperate}
      />,
    ),
  );
  return { host, root };
}

const startOverButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('[aria-label="Start over"]');

async function confirmStartOver(host: HTMLElement) {
  await act(async () => startOverButton(host)!.click());
  await act(async () => mocks.confirm.mock.calls[0]![0].onConfirm());
}

describe("ThreadSideChatBar", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const mock of [mocks.alert, mocks.confirm, mocks.open]) mock.mockReset();
    mocks.ready = true;
    mocks.commands = {
      delete: vi.fn(async () => ({ _tag: "Success" })),
      forkSideChat: vi.fn(async () => ({ _tag: "Success" })),
    };
    mocks.parent = {
      title: "Fix the build",
      runtime: { status: "running" },
      latestRun: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      goal: null,
    };
  });

  it("names the parent and says what it is doing", async () => {
    const { host, root } = await mount();
    expect(host.textContent).toContain("Fix the build");
    expect(host.querySelector('[aria-label="Main thread: Working"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("starts over after confirming: opens a fresh side chat, then deletes this one", async () => {
    const { host, root } = await mount();
    await confirmStartOver(host);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    expect(mocks.commands.forkSideChat).toHaveBeenCalledWith({
      environmentId,
      input: { sourceThreadId: "parent", targetThreadId: "new-side", title: "Side chat" },
    });
    expect(mocks.open).toHaveBeenCalledWith(
      { environmentId, threadId: "new-side" },
      { replace: true },
    );
    expect(mocks.commands.delete).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: "side-old" },
    });
    await act(async () => root.unmount());
  });

  it("keeps this side chat and alerts when the fresh one cannot start", async () => {
    mocks.commands.forkSideChat = vi.fn(async () => ({
      _tag: "Failure",
      error: new Error("offline"),
    }));
    const { host, root } = await mount();
    await confirmStartOver(host);
    expect(mocks.alert).toHaveBeenCalledWith("Could not start a side chat", "offline");
    expect(mocks.commands.delete).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("keeps this side chat when the fresh one has not reached the device", async () => {
    mocks.ready = false;
    const { host, root } = await mount();
    await confirmStartOver(host);
    expect(mocks.alert).toHaveBeenCalledWith("Side chat created", expect.any(String));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.commands.delete).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("offers no start over without operate access, and tolerates a missing parent", async () => {
    mocks.parent = null;
    const { host, root } = await mount(false);
    expect(startOverButton(host)).toBeNull();
    expect(host.textContent).toContain("main thread");
    await act(async () => root.unmount());
  });
});
