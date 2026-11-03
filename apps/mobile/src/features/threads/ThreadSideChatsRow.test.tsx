import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { update: vi.fn(), alert: vi.fn(), open: vi.fn() },
}));

vi.mock("react-native", () => ({
  Pressable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
  useSideChats: () => [{ id: "side-1", title: "Quick question" }],
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => mocks.open }));

import { ThreadSideChatsRow } from "./ThreadSideChatsRow";

const environmentId = "env" as EnvironmentId;

async function turnIntoThread() {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(<ThreadSideChatsRow environmentId={environmentId} threadId={"t" as ThreadId} />),
  );
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Turn into thread",
  );
  await act(async () => button!.click());
  await act(async () => root.unmount());
}

describe("ThreadSideChatsRow", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("detaches the side chat, then opens it as a thread", async () => {
    mocks.update.mockResolvedValue({ _tag: "Success" });
    await turnIntoThread();
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: "side-1", detachSideChat: true },
    });
    expect(mocks.open).toHaveBeenCalledWith({ environmentId, threadId: "side-1" });
  });

  it("alerts and stays put when the command fails", async () => {
    mocks.update.mockResolvedValue({ _tag: "Failure", error: new Error("nope") });
    await turnIntoThread();
    expect(mocks.alert).toHaveBeenCalledWith("Could not turn into thread", "nope");
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
