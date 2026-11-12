import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { useProject, useThreadShell } from "../../state/entities";
import { useKanbanEnvironmentIds } from "../../state/kanban";
import { ProjectBoardView } from "../kanban/ProjectBoardView";
import { HeavyCommandsSection, HeavyQueueSection } from "../settings/components/HeavyQueueSection";
import { ProjectScheduledTasksView } from "../settings/ProjectScheduledTasksView";
import { ProjectActivityView } from "./ProjectActivityView";
import { ProjectMemoryView } from "./ProjectMemoryView";
import { ProjectViewMessage } from "./ProjectViewMessage";
import {
  PROJECT_VIEW_META,
  projectViewsFor,
  resolveProjectView,
  type ProjectView,
} from "./projectViews";
import { useLeaveSheet } from "./useLeaveSheet";

type ProjectViewTarget = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly view?: string;
};

/** The thread's project in one sheet: its board, schedule, activity, memory and heavy work. */
export function ProjectViewSheet({ route }: StaticScreenProps<ProjectViewTarget>) {
  const navigation = useNavigation();
  const leaveSheet = useLeaveSheet();
  const insets = useSafeAreaInsets();
  const topInset = useContentTopInset();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const views = projectViewsFor(useKanbanEnvironmentIds().includes(environmentId));
  const [chosen, setChosen] = useState<string | undefined>(route.params.view);
  const view = resolveProjectView(views, chosen);
  const thread = useThreadShell(
    scopeThreadRef(environmentId, ThreadId.make(route.params.threadId)),
  );
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const openThread = (threadId: ThreadId) => leaveSheet("Thread", { environmentId, threadId });
  const content = (() => {
    if (project === null) {
      return (
        <ProjectViewMessage
          title="Project not found"
          detail="This thread's project is not on this server anymore."
        />
      );
    }
    const target = { environmentId, projectId: project.id };
    switch (view) {
      case "board":
        return <ProjectBoardView {...target} />;
      case "scheduled":
        return <ProjectScheduledTasksView {...target} />;
      case "activity":
        return <ProjectActivityView {...target} onOpenThread={openThread} />;
      case "memory":
        return <ProjectMemoryView {...target} />;
      case "heavy-work":
        return (
          <>
            <HeavyCommandsSection {...target} />
            <HeavyQueueSection {...target} />
          </>
        );
    }
  })();
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader
        title={project?.title ?? "Project"}
        onClose={() => navigation.goBack()}
        {...(view === "scheduled"
          ? {
              actions: [
                {
                  accessibilityLabel: "Manage scheduled tasks",
                  icon: "gearshape",
                  onPress: () => leaveSheet("SettingsScheduledTasks"),
                },
              ],
            }
          : {})}
      />
      <ScreenContent>
        {/* The tabs stay pinned, so they sit below the sheet's native bar instead of scrolling under it. */}
        <View className="items-center px-4 pb-2" style={{ paddingTop: topInset + 4 }}>
          <SegmentedControl<ProjectView>
            className="w-full max-w-[520px]"
            options={views.map((value) => ({
              value,
              label: PROJECT_VIEW_META[value].title,
              icon: PROJECT_VIEW_META[value].icon,
            }))}
            selected={view}
            onSelect={setChosen}
            role="tab"
          />
        </View>
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 px-4 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {content}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
