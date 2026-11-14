import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-haptics", () => ({ selectionAsync: () => Promise.resolve() }));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: { onPress?: () => void; children?: ReactNode }) => (
    <button onClick={props.onPress}>{props.children}</button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button data-use onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("./thread-work-log", () => ({ ThreadDisclosureChevron: () => null }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { markdown: string }) => <p>{props.markdown}</p>,
}));
vi.mock("../../native/useEnrichedLinkVariants", () => ({ withChipIcon: () => undefined }));
vi.mock("../../state/model-mentions", () => ({ useModelMentions: () => [] }));
vi.mock("../../state/entities", () => ({
  useLiveThreadLinkLabels: (markdown: string) => markdown.replace("{live}", "Live title"),
  useThreadChipIcons: () => new Map(),
}));

const { AssistantMarkdownContent } = await import("./AssistantMarkdownContent");

const TEMPLATE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

async function mount(markdown: string, onUseArtifactTemplate?: () => void) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = window.document.createElement("div");
  await act(async () =>
    createRoot(container).render(
      <AssistantMarkdownContent
        markdown={markdown}
        environmentId={"env-1" as EnvironmentId}
        markdownStyles={{ nativeTextStyle: {} as never }}
        linkHandlers={{} as never}
        renderImage={(() => null) as never}
        onUseArtifactTemplate={onUseArtifactTemplate}
      />,
    ),
  );
  return container;
}

describe("AssistantMarkdownContent", () => {
  it("renders markdown with live thread titles substituted", async () => {
    const view = await mount("See {live} now");
    expect(view.textContent).toContain("See Live title now");
  });

  it("keeps a details body behind its summary until opened", async () => {
    const view = await mount("<details>\n<summary>More</summary>\n\nhidden body\n\n</details>");
    expect(view.textContent).toContain("More");
    expect(view.textContent).not.toContain("hidden body");
    await act(async () => view.querySelector("button")!.click());
    expect(view.textContent).toContain("hidden body");
  });

  it("shows an artifact template card whose Use button hands the template back", async () => {
    const onUse = vi.fn();
    const view = await mount(`Before\n\n${TEMPLATE}\n\nAfter`, onUse);
    expect(view.textContent).toContain("Hello World");
    await act(async () => view.querySelector<HTMLButtonElement>("button[data-use]")!.click());
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Hello World" }));
  });
});
