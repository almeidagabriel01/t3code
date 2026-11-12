import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useProject, useThreadShell } from "../../state/entities";
import { HeavyCommandsSection, HeavyQueueSection } from "../settings/components/HeavyQueueSection";
import { ProjectActivityView } from "./ProjectActivityView";
import { ProjectMemoryView } from "./ProjectMemoryView";
import { ProjectViewMessage } from "./ProjectViewMessage";
import { isProjectView, PROJECT_VIEW_META, PROJECT_VIEWS, type ProjectView } from "./projectViews";

type ProjectViewTarget = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly view: string;
};

/** The thread's project seen three ways: its Activity, Memory and Heavy work, one at a time. */
export function ProjectViewSheet({ route }: StaticScreenProps<ProjectViewTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const [view, setView] = useState<ProjectView>(
    isProjectView(route.params.view) ? route.params.view : "activity",
  );
  const thread = useThreadShell(
    scopeThreadRef(environmentId, ThreadId.make(route.params.threadId)),
  );
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const openThread = (threadId: ThreadId) =>
    // A thread replaces the leaf sheet so workspace back navigation still works.
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
  const content =
    project === null ? (
      <ProjectViewMessage
        title="Project not found"
        detail="This thread's project is not on this server anymore."
      />
    ) : view === "activity" ? (
      <ProjectActivityView
        environmentId={environmentId}
        projectId={project.id}
        onOpenThread={openThread}
      />
    ) : view === "memory" ? (
      <ProjectMemoryView environmentId={environmentId} projectId={project.id} />
    ) : (
      <>
        <HeavyCommandsSection environmentId={environmentId} projectId={project.id} />
        <HeavyQueueSection environmentId={environmentId} projectId={project.id} />
      </>
    );
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title={project?.title ?? "Project"} onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 px-4 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          <SegmentedControl
            options={PROJECT_VIEWS.map((value) => ({
              value,
              label: PROJECT_VIEW_META[value].title,
            }))}
            selected={view}
            onSelect={setView}
            size="compact"
            role="tab"
          />
          {content}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
