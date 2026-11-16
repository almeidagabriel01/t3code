import { useRoute } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import type { AppBarProps } from "../../../components/ui/AppBar.types";
import { AppBar } from "../../../components/ui/AppBar";
import { ScreenContent as SettingsScreenContent } from "../../../components/ui/ScreenContent";
import { useWorkspaceTabs } from "../../layout/workspace/WorkspaceTabsContext";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../../layout/adaptive-workspace-context";
import { usePaneRole } from "../../../components/ui/Pane";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { useCompactWorkspaceTabs } from "../../layout/workspace/useSystemWorkspaceTabBar";
import { useSettingsPageBack } from "../useSettingsPageBack";
import {
  ScreenScrollViewBottomInset,
  ScreenScrollViewSurface,
} from "../../../components/ui/ScreenScrollView";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<
    AppBarProps,
    "title" | "actions" | "refresh" | "trailing" | "search" | "menus" | "guardBack"
  > & {
    readonly children: ReactNode;
    readonly workspaceRoot?: boolean;
  },
) {
  const route = useRoute();
  const workspace = useWorkspaceTabs();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const back = useSettingsPageBack();
  const cover = deviceType === "duo-folded";
  // Opened as a workspace tab, the Settings list has nothing to go back to.
  const workspaceRoot = props.workspaceRoot || (workspace !== null && route.name === "Settings");
  const { layout } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const paneRole = usePaneRole();
  // The Settings list beside this page already carries the settings filter. On iPad it lives in
  // the primary sidebar, which can be hidden; Android keeps its own list column in a split.
  const listBeside =
    !workspaceRoot &&
    paneRole === "content" &&
    workspace?.settingsOpen === true &&
    layout.usesSplitView &&
    (Platform.OS === "android" || panes.primarySidebarVisible);

  const surfaceClassName = workspaceRoot || cover ? "bg-screen" : "bg-sheet";

  return (
    <View collapsable={false} className={`flex-1 ${surfaceClassName}`}>
      <AppBar
        title={props.title}
        actions={props.actions}
        refresh={props.refresh}
        search={props.search}
        trailing={props.trailing}
        menus={listBeside ? undefined : props.menus}
        onBack={workspaceRoot ? undefined : back}
        guardBack={props.guardBack}
        hideBottomBorder
      />
      <ScreenScrollViewBottomInset value={deviceType === "pad" || compactTabs ? 80 : 0}>
        <ScreenScrollViewSurface value={surfaceClassName}>
          <SettingsScreenContent>{props.children}</SettingsScreenContent>
        </ScreenScrollViewSurface>
      </ScreenScrollViewBottomInset>
    </View>
  );
}
