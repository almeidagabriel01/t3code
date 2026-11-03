import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    update: vi.fn(),
    alert: vi.fn(),
    open: vi.fn(),
    start: vi.fn(),
    sideChats: [] as unknown[],
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
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: ReadonlyArray<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    shouldOpenOnLongPress?: boolean;
    children?: ReactNode;
  }) => (
    <div>
      {props.children}
      {props.shouldOpenOnLongPress
        ? props.actions.map((action) => (
            <button
              key={action.id}
              onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
            >
              {action.title}
            </button>
          ))
        : null}
    </div>
  ),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { error: unknown }) => result.error,
}));
vi.mock("../../state/entities", () => ({
  useSideChats: () => mocks.sideChats,
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("./useStartSideChat", () => ({ useStartSideChat: () => mocks.start }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => mocks.open }));

import { ThreadSideChatsRow } from "./ThreadSideChatsRow";

const environmentId = "env" as EnvironmentId;

async function mount(canOperate = true) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ThreadSideChatsRow
        environmentId={environmentId}
        threadId={"t" as ThreadId}
        canOperate={canOperate}
      />,
    ),
  );
  return { host, root };
}

async function turnIntoThread() {
  const { host, root } = await mount();
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Turn into thread",
  );
  await act(async () => button!.click());
  await act(async () => root.unmount());
}

describe("ThreadSideChatsRow", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const mock of [mocks.update, mocks.alert, mocks.open, mocks.start]) mock.mockReset();
    mocks.sideChats = [{ id: "side-1", title: "Quick question" }];
  });

  it("detaches the side chat, then opens it as a thread", async () => {
    mocks.update.mockResolvedValue({ _tag: "Success" });
    await turnIntoThread();
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: "side-1", detachSideChat: true, regenerateTitle: true },
    });
    expect(mocks.open).toHaveBeenCalledWith({ environmentId, threadId: "side-1" });
  });

  it("alerts and stays put when the command fails", async () => {
    mocks.update.mockResolvedValue({ _tag: "Failure", error: new Error("nope") });
    await turnIntoThread();
    expect(mocks.alert).toHaveBeenCalledWith("Could not turn into thread", "nope");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("starts a side chat from the plus button, even with none yet", async () => {
    mocks.sideChats = [];
    const { host, root } = await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="New side chat"]')!.click(),
    );
    expect(mocks.start).toHaveBeenCalledWith("t");
    await act(async () => root.unmount());
  });

  it("hides the row when there are no side chats and the connection cannot operate", async () => {
    mocks.sideChats = [];
    const { host, root } = await mount(false);
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
  });
});
