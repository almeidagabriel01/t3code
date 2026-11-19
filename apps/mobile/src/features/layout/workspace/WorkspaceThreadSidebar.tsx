import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useNavigation, useNavigationState } from "@react-navigation/native";

import { uuidv4 } from "../../../lib/uuid";
import { usePendingTaskListActions } from "../../home/usePendingTaskListActions";
import { useAdaptiveWorkspaceLayout, useWorkspacePaneState } from "../adaptive-workspace-context";
import { openSettings } from "../../settings/settings-navigation";
import { ThreadNavigationSidebar } from "../../threads/ThreadNavigationSidebar";
import { useOpenThreadPullRequests } from "../../threads/use-open-thread-pull-requests";
import { openConversationKey } from "./open-conversation-key";
import { useSelectWorkspaceDetail } from "./useSelectWorkspaceDetail";

/** The thread list in the workspace's sidebar column. */
export function WorkspaceThreadSidebar() {
  const navigation = useNavigation();
  const { layout, setPrimarySidebarSearchQuery, revealPrimarySidebar, openWorkspaceTab } =
    useAdaptiveWorkspaceLayout();
  const { panes, primarySidebarSearchQuery } = useWorkspacePaneState();
  const selectDetail = useSelectWorkspaceDetail();
  const openThreadPullRequests = useOpenThreadPullRequests();
  const selectedThread = useNavigationState(openConversationKey);
  const selectThreadRoute = (params: ReactNavigation.RootParamList["Thread"]) =>
    selectDetail({ name: "Thread", params });
  const { openPendingTask } = usePendingTaskListActions(selectThreadRoute);
  return (
    <ThreadNavigationSidebar
      width={layout.listPaneWidth ?? 0}
      visible={panes.primarySidebarVisible}
      onRequestVisibility={revealPrimarySidebar}
      selectedThreadKey={selectedThread}
      onOpenSettings={() => openWorkspaceTab("settings")}
      onOpenEnvironmentSettings={() => openSettings(navigation, "SettingsEnvironments")}
      onNewThreadInProject={(project: EnvironmentProject) =>
        selectThreadRoute({
          draft: {
            requestId: uuidv4(),
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            title: project.title,
          },
        })
      }
      onNewThreadOnBranch={(thread: EnvironmentThreadShell) =>
        selectThreadRoute({
          draft: {
            requestId: uuidv4(),
            environmentId: String(thread.environmentId),
            projectId: String(thread.projectId),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
          },
        })
      }
      onOpenPendingTask={openPendingTask}
      onSelectThread={(thread) =>
        selectThreadRoute({
          environmentId: String(thread.environmentId),
          threadId: String(thread.id),
        })
      }
      onOpenThreadPullRequests={openThreadPullRequests}
      onSearchQueryChange={setPrimarySidebarSearchQuery}
      searchQuery={primarySidebarSearchQuery}
    />
  );
}
