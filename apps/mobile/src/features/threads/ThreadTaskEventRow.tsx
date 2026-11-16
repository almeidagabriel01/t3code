import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { taskEventActivity } from "@t3tools/client-runtime/assistantTasks";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";
import { useQuietThreadShell } from "../../state/entities";
import { TaskEventActivityRow } from "./TaskEventActivityRow";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function ThreadTaskEventRow(props: {
  readonly environmentId: EnvironmentId;
  readonly message: Parameters<typeof taskEventActivity>[0];
  readonly activity: NonNullable<ReturnType<typeof taskEventActivity>>;
}) {
  const openLinkedThread = useOpenLinkedThread();
  const shell = useQuietThreadShell(
    scopeThreadRef(props.environmentId, props.activity.threadId as ThreadId),
  );
  // An event T3 did not write carries no title; the task thread's own one stands in.
  const activity = taskEventActivity(props.message, shell?.title.trim() || null) ?? props.activity;
  return (
    <View className="mb-0.5 px-1">
      <TaskEventActivityRow
        title={activity.title}
        label={activity.label}
        status={activity.status}
        onOpen={() =>
          openLinkedThread({
            environmentId: String(props.environmentId),
            threadId: activity.threadId,
          })
        }
      />
    </View>
  );
}
