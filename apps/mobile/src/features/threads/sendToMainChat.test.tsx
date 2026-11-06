import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { open: vi.fn(), set: vi.fn(), text: "" },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: (props: {
    children: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: () => ({ text: mocks.text }),
  setComposerDraftText: mocks.set,
}));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => mocks.open }));

import { SendToMainChatButton } from "./SendToMainChatButton";
import { useSendToMainChat } from "./sendToMainChat";

const environmentId = "env" as EnvironmentId;
const parentThreadId = "parent" as ThreadId;

function mountHook(parent: ThreadId | null) {
  const seen = vi.fn();
  function Probe() {
    const send = useSendToMainChat(environmentId, parent);
    useEffect(() => seen(send), [send]);
    return null;
  }
  act(() => createRoot(document.createElement("div")).render(<Probe />));
  return seen.mock.calls[0]![0] as ((text: string) => void) | undefined;
}

describe("sendToMainChat", () => {
  beforeEach(() => {
    mocks.open.mockClear();
    mocks.set.mockClear();
    mocks.text = "";
  });

  it("is unavailable outside a side chat", () => {
    expect(mountHook(null)).toBeUndefined();
  });

  it("replaces an empty draft and opens the parent", () => {
    mountHook(parentThreadId)!("answer");
    expect(mocks.set).toHaveBeenCalledWith("env:parent", "answer");
    expect(mocks.open).toHaveBeenCalledWith({ environmentId, threadId: parentThreadId });
  });

  it("appends after a blank line to a non-empty draft", () => {
    mocks.text = "draft";
    mountHook(parentThreadId)!("answer");
    expect(mocks.set).toHaveBeenCalledWith(expect.any(String), "draft\n\nanswer");
  });

  it("button fires onPress", () => {
    const onPress = vi.fn();
    const host = document.createElement("div");
    act(() =>
      createRoot(host).render(
        <SendToMainChatButton iconColor="red" buttonSize={28} iconSize={14} onPress={onPress} />,
      ),
    );
    act(() => host.querySelector("button")!.click());
    expect(onPress).toHaveBeenCalledOnce();
  });
});
