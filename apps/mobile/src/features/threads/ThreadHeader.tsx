import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { isDuoDevice } from "../../lib/device-type";
import { useDeviceType } from "../../native/native-layout-metrics";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useThreadAssistant } from "../../state/assistants";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import { useThreadMenu } from "./useThreadMenu";

export function ThreadHeader(props: {
  /** The open thread; the actions menu is absent for drafts. */
  readonly thread?: EnvironmentThreadShell;
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, panes, toggleAuxiliaryPane, composerKeyboardActive, startNewTask } =
    useAdaptiveWorkspaceLayout();
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const deviceType = useDeviceType();
  const assistant = useThreadAssistant(
    props.thread?.environmentId ?? null,
    props.thread?.id ?? null,
  );
  const title = assistant ? assistant.assistant.name : props.title;
  const { items: actionItems, customSnoozeSheet } = useThreadMenu(props.thread, () => {
    // A split view has no list to return to; the deleted or archived thread's own state shows instead.
    if (!layout.usesSplitView) goBack();
  });
  // The compact phone header keeps Terminal plus one menu; wide and Duo headers keep their own buttons.
  const toolsInMenu =
    props.thread !== undefined &&
    !layout.usesSplitView &&
    !(usesNativeWorkspaceColumns && isDuoDevice(deviceType));
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] =
    props.hasThreadCwd && !toolsInMenu
      ? [
          {
            accessibilityLabel: filesVisible ? "Close files" : "Open files",
            icon: "folder",
            selected: filesVisible,
            disabled: !props.gitControls.canOpenFiles,
            separateBackground: false,
            onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
          },
        ]
      : [];
  const threadMenuItems: AppBarMenuItem[] = [
    ...(toolsInMenu && gitMenu
      ? [
          {
            id: "git",
            title: "Git",
            icon: typeof gitMenu.icon === "string" ? gitMenu.icon : gitMenu.icon.ios,
            items: gitMenu.items,
          },
        ]
      : []),
    ...(toolsInMenu
      ? [
          {
            id: "files",
            title: "Files",
            icon: "folder",
            disabled: !props.gitControls.canOpenFiles,
            onPress: props.onOpenFilesInspector,
          },
        ]
      : []),
    ...(actionItems ? [{ id: "thread-actions", inline: true, items: actionItems }] : []),
  ];
  const threadMenu: AppBarMenu | null =
    threadMenuItems.length === 0
      ? null
      : { title: "Thread", icon: "ellipsis", separateBackground: false, items: threadMenuItems };
  const menus = [threadMenu, toolsInMenu ? null : gitMenu, terminalMenu].filter(
    (menu): menu is AppBarMenu => menu !== null,
  );

  return (
    <>
      <AppBar
        title={title}
        subtitle={props.subtitle}
        onBackToList={goBack}
        onCompose={props.draft ? undefined : startNewTask}
        backInSplitView={
          props.onReturnToThread
            ? {
                accessibilityLabel: "Return to chat",
                icon: "chevron.left",
                onPress: props.onReturnToThread,
              }
            : undefined
        }
        actions={actions}
        menus={menus}
        hideBottomBorder
        compact={composerKeyboardActive}
      />
      {customSnoozeSheet}
    </>
  );
}
