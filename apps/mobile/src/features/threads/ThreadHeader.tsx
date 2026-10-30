import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { isDuoDevice } from "../../lib/device-type";
import { useDeviceType } from "../../native/native-layout-metrics";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { buildThreadToolsMenuItems } from "./thread-header-tools";
import { useThreadMenu } from "./useThreadMenu";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

export function ThreadHeader(
  props: Parameters<typeof useThreadHeaderOptions>[0] & {
    /** The open thread; the actions menu is absent for drafts. */
    readonly thread?: EnvironmentThreadShell;
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
  },
) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, panes, toggleAuxiliaryPane, composerKeyboardActive } =
    useAdaptiveWorkspaceLayout();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const navigation = useNavigation();
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const deviceType = useDeviceType();
  const { items: actionItems, customSnoozeSheet } = useThreadMenu(props.thread, () => {
    // A split view has no list to return to; the deleted or archived thread's own state shows instead.
    if (!layout.usesSplitView) goBack();
  });
  // The compact phone header keeps Git plus one menu; wide and Duo headers keep their own buttons.
  const toolsInMenu =
    props.thread !== undefined &&
    !layout.usesSplitView &&
    !(usesNativeWorkspaceColumns && isDuoDevice(deviceType));
  const { gitControls } = props;
  const menuItems = [
    ...(toolsInMenu
      ? buildThreadToolsMenuItems({
          ...gitControls,
          onOpenFiles:
            gitControls.onOpenFilesInspector ??
            (() =>
              navigation.navigate("ThreadFiles", {
                environmentId: String(gitControls.environmentId),
                threadId: String(gitControls.threadId),
              })),
        })
      : []),
    ...(actionItems ? [{ id: "thread-actions", inline: true, items: actionItems }] : []),
  ];
  const threadMenu: AppBarMenu | null =
    menuItems.length === 0
      ? null
      : { title: "Thread", icon: "ellipsis", separateBackground: false, items: menuItems };
  const native = useThreadHeaderOptions({
    ...props,
    gitControls: { ...gitControls, threadMenu, toolsInMenu },
  });
  const androidHeaderActions = useMemo<ReadonlyArray<AppBarAction>>(() => {
    const actions: AppBarAction[] = [];
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (!toolsInMenu && props.hasThreadCwd) {
      const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
      actions.push({
        accessibilityLabel: filesVisible ? "Close files" : "Open files",
        selected: filesVisible,
        icon: "folder",
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      });
    }
    if (!toolsInMenu && props.hasWorkspaceRoot && props.gitControls.canOpenTerminal) {
      actions.push({
        accessibilityLabel: "Open terminal",
        icon: "terminal",
        onPress: () => onOpenTerminal(null),
      });
    }
    actions.push({
      accessibilityLabel: "Open git controls",
      icon: "point.topleft.down.curvedto.point.bottomright.up",
      onPress: props.onOpenGitInspector,
    });
    if (onMergeBack) {
      actions.push({
        accessibilityLabel: "Merge back to source",
        icon: PullRequestGlyph.merged,
        onPress: onMergeBack,
      });
    }
    return actions;
  }, [
    props.inspectorMode,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    onOpenTerminal,
    onMergeBack,
    props.onOpenGitInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
    props.gitControls.canOpenTerminal,
    toolsInMenu,
  ]);
  // iOS shows the menu as a native header item (see ThreadGitControls); AppBar menus would duplicate it.
  const menus = useMemo(
    () => (Platform.OS === "android" && threadMenu ? [threadMenu] : []),
    [threadMenu],
  );

  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        sidebar={native.sidebar}
        options={native.options}
        optionsVersion={native.optionsVersion}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd ? (
            <ScreenHeaderButton
              accessibilityLabel={
                props.inspectorMode !== null && panes.auxiliaryPaneVisible
                  ? "Hide inspector"
                  : "Show inspector"
              }
              icon="sidebar.right"
              selected={props.inspectorMode !== null && panes.auxiliaryPaneVisible}
              onPress={props.onToggleInspector}
            />
          ) : null
        }
        onBack={layout.usesSplitView ? undefined : goBack}
        actions={androidHeaderActions}
        menus={menus}
        hideBottomBorder
        compact={composerKeyboardActive}
      />
      {native.fallback}
      {customSnoozeSheet}
    </>
  );
}
