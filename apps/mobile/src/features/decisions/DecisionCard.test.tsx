import type { Decision } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    shell: null as null | { projectId: string },
    navigateToPullRequest: vi.fn(),
    answer: vi.fn(() => Promise.resolve({ ok: true })),
    clear: vi.fn(),
    files: {
      canAttach: true,
      settled: true,
      uploaded: [] as unknown[],
    },
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
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button data-label={props.label} disabled={props.disabled} onClick={props.onPress} />
  ),
}));
vi.mock("./DecisionAttachments", () => ({
  useDecisionAttachments: () => ({ ...mocks.files, clear: mocks.clear }),
  DecisionAttachmentControls: () => <i data-attach-controls />,
}));
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
  useDecisionActions: () => ({ canAct: true, answer: mocks.answer, dismiss: vi.fn() }),
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
  mocks.answer.mockClear();
  mocks.clear.mockClear();
  mocks.files = { canAttach: true, settled: true, uploaded: [] };
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

describe("DecisionCard attachments", () => {
  const answerButton = () =>
    container.querySelector<HTMLButtonElement>('button[data-label="Answer"]')!;

  it("answers with attachments alone, and clears the draft once accepted", async () => {
    const file = { type: "file", id: "pending-1", name: "plan.pdf", mimeType: "x", sizeBytes: 1 };
    mocks.files = { canAttach: true, settled: true, uploaded: [file] };
    render(null);
    expect(container.querySelector("[data-attach-controls]")).not.toBeNull();
    expect(answerButton().disabled).toBe(false);
    await act(async () => answerButton().click());
    expect(mocks.answer).toHaveBeenCalledWith("d1", { attachments: [file] });
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });

  it("holds the answer while files are still uploading, and hides attaching when it cannot", () => {
    mocks.files = { canAttach: false, settled: false, uploaded: [{}] };
    render(null);
    expect(container.querySelector("[data-attach-controls]")).toBeNull();
    expect(answerButton().disabled).toBe(true);
  });
});
