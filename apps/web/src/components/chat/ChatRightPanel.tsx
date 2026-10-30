import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";
import { RightPanelFixedTabs } from "./RightPanelFixedTabs";

type ChatRightPanelProps = Omit<RightPanelTabsProps, "mode" | "inlineSize" | "maximized"> & {
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly widthStorageKey: string;
  readonly sheetAnimationDurationMs: number;
  readonly onCloseSheet: () => void;
  readonly onAddSideChat: () => void;
  readonly sideChatAvailable: boolean;
};

/**
 * The right panel, inline beside the chat column or as a sheet on narrow
 * layouts. Its width follows a resize drag every frame, so the width state
 * lives here rather than in ChatView.
 */
export function ChatRightPanel(props: ChatRightPanelProps) {
  const {
    sheet,
    workspaceLayoutElement,
    widthStorageKey,
    sheetAnimationDurationMs,
    onCloseSheet,
    maximized,
    layoutControls,
    onAddSideChat,
    sideChatAvailable,
    ...tabs
  } = props;
  const inlineSize = usePreviewPanelInlineSize({
    container: workspaceLayoutElement,
    widthStorageKey,
  });
  const fixedTabs = (
    <>
      <RightPanelFixedTabs
        surfaces={tabs.surfaces}
        activeSurfaceId={tabs.activeSurfaceId}
        onActivate={tabs.onActivate}
        onAdd={{
          files: tabs.onAddFiles,
          diff: tabs.onAddDiff,
          terminal: tabs.onAddTerminal,
          preview: tabs.onAddBrowser,
          "pull-requests": tabs.onAddPullRequests,
          "pull-request": tabs.onAddPullRequest,
          notes: tabs.onAddNotes,
          "side-chat": onAddSideChat,
          device: tabs.onAddDevice,
        }}
        available={{
          files: tabs.filesAvailable,
          diff: tabs.diffAvailable,
          terminal: tabs.terminalAvailable,
          preview: tabs.browserAvailable,
          "pull-requests": tabs.pullRequestsAvailable,
          "pull-request": tabs.pullRequestAvailable,
          notes: tabs.notesAvailable,
          "side-chat": sideChatAvailable,
          device: tabs.deviceAvailable,
        }}
      />
      {tabs.children}
    </>
  );
  if (!sheet) {
    return (
      <RightPanelTabs {...tabs} mode="inline" maximized={maximized} inlineSize={inlineSize}>
        {fixedTabs}
      </RightPanelTabs>
    );
  }
  return (
    <RightPanelSheet
      animationDurationMs={sheetAnimationDurationMs}
      open={tabs.open === true}
      onClose={onCloseSheet}
    >
      <RightPanelTabs
        {...tabs}
        mode="sheet"
        inlineSize={inlineSize}
        layoutControls={layoutControls}
      >
        {fixedTabs}
      </RightPanelTabs>
    </RightPanelSheet>
  );
}
