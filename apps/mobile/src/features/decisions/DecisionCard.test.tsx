import type { Decision } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    shell: null as null | { projectId: string },
    navigateToPullRequest: vi.fn(),
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: Children,
  TextInput: () => null,
}));
// The card renders in the tablet sidebar, outside any screen, where useRoute throws.
vi.mock("@react-navigation/native", () => ({
  useRoute: () => {
    throw new Error("useRoute outside a screen");
  },
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children, AppTextInput: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { markdown: string; onLinkPress: (href: string) => void }) => (
    <button onClick={() => props.onLinkPress("https://github.com/o/r/pull/7")}>
      {props.markdown}
    </button>
  ),
}));
vi.mock("../../native/useOpenPullRequest", () => ({
  useNavigateToPullRequest: () => mocks.navigateToPullRequest,
}));
vi.mock("../../state/decisions", () => ({
  useDecisionActions: () => ({ canAct: true, answer: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("../../state/entities", () => ({
  useLiveThreadLinkLabels: (markdown: string) => markdown,
  useThreadShell: () => mocks.shell,
}));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));

import { DecisionCard } from "./DecisionCard";

const decision = {
  id: "d1",
  fromThreadId: "thread-1",
  threadTitle: "Thread",
  title: "Ship it?",
  context: "See the PR",
  options: [{ id: "yes", label: "Yes" }],
  status: "open",
} as unknown as Decision;

let root: Root;
let container: HTMLDivElement;
const openLink = () => act(() => container.querySelector<HTMLButtonElement>("button")!.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.navigateToPullRequest.mockReset();
});
const render = (shell: { projectId: string } | null) => {
  mocks.shell = shell;
  act(() => root.render(<DecisionCard environmentId={"hub" as never} decision={decision} />));
};
afterEach(() => act(() => root.unmount()));

describe("DecisionCard context links", () => {
  it("opens a link with the requesting thread's project", () => {
    render({ projectId: "p1" });
    openLink();
    expect(mocks.navigateToPullRequest).toHaveBeenCalledWith("https://github.com/o/r/pull/7", {
      environmentId: "hub",
      projectId: "p1",
    });
  });

  it("opens a link without a project when the thread is not loaded", () => {
    render(null);
    openLink();
    expect(mocks.navigateToPullRequest).toHaveBeenCalledWith("https://github.com/o/r/pull/7", null);
  });
});
