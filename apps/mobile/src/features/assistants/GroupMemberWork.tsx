import {
  ASSISTANT_GROUP_STATUS_LABEL,
  ASSISTANT_GROUP_TASK_MOOD,
  assistantGroupRequestOwners,
  assistantGroupTaskTree,
  type AssistantGroupMemberWork,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  ASSISTANT_GROUP_WORKING_TASK_STATUSES,
  type Assistant,
  type AssistantGroupTask,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useVisibleSecondClock } from "../threads/use-visible-second-clock";
import { AssistantAvatar, removedAssistantFace } from "./assistantPresentation";

const WORKING: ReadonlySet<AssistantGroupTask["status"]> = new Set(
  ASSISTANT_GROUP_WORKING_TASK_STATUSES,
);

/** How long a task has run: until now while it works, until its last change once it stopped. */
export function groupTaskDuration(task: AssistantGroupTask, now: number): string {
  const end = WORKING.has(task.status) ? now : Date.parse(task.updatedAt);
  return formatDuration(Math.max(0, end - Date.parse(task.createdAt)));
}

/** The member a task belongs to, or a placeholder once it left the group. */
export function groupTaskOwner(
  task: AssistantGroupTask,
  members: ReadonlyMap<string, Assistant>,
): { readonly name: string; readonly face: Pick<Assistant, "id" | "avatar" | "icon"> } {
  const member = members.get(task.ownerId);
  return member === undefined
    ? { name: "Removed member", face: removedAssistantFace(task.ownerId) }
    : { name: member.name, face: member };
}

interface WorkProps {
  readonly environmentId: EnvironmentId;
  /** The group's current members, by id: anyone else shows as a removed member. */
  readonly members: ReadonlyMap<string, Assistant>;
  readonly onOpenThread: (threadId: AssistantGroupTask["threadId"]) => void;
}

/** A request's owners, each by its newest task there; a tap opens that member's thread in it. */
export function RequestOwners(
  props: WorkProps & { readonly tasks: ReadonlyArray<AssistantGroupTask> },
) {
  const owners = assistantGroupRequestOwners(props.tasks);
  if (owners.length === 0) return null;
  return (
    <View testID="group-request-owners" className="flex-row items-center">
      {owners.map((task) => {
        const owner = groupTaskOwner(task, props.members);
        return (
          <Pressable
            key={task.id}
            accessibilityRole="button"
            accessibilityLabel={`${owner.name}, ${ASSISTANT_GROUP_STATUS_LABEL[task.status]}. Open thread`}
            hitSlop={4}
            onPress={() => props.onOpenThread(task.threadId)}
            className="size-8 cursor-pointer items-center justify-center rounded-full active:opacity-70"
          >
            <AssistantAvatar
              assistant={owner.face}
              environmentId={props.environmentId}
              mood={ASSISTANT_GROUP_TASK_MOOD[task.status]}
              size={22}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** An open request's tasks as a tree: the root, its delegations and their replies. */
export function RequestTaskTree(
  props: WorkProps & { readonly tasks: ReadonlyArray<AssistantGroupTask> },
) {
  const tree = assistantGroupTaskTree(props.tasks);
  const now = useVisibleSecondClock(
    tree.length > 1 && tree.some(({ task }) => WORKING.has(task.status)),
  );
  // One task is already the request's card.
  if (tree.length < 2) return null;
  return (
    <View testID="group-task-tree" accessibilityLabel="Tasks in this request" className="gap-0.5">
      {tree.map(({ task, depth }) => {
        const owner = groupTaskOwner(task, props.members);
        const status = ASSISTANT_GROUP_STATUS_LABEL[task.status];
        const duration = groupTaskDuration(task, now);
        return (
          <Pressable
            key={task.id}
            accessibilityRole="button"
            accessibilityLabel={`${owner.name}, ${status}, ${duration}. Open thread`}
            onPress={() => props.onOpenThread(task.threadId)}
            className="min-h-9 cursor-pointer flex-row items-center gap-2 rounded-lg pr-2 active:bg-foreground/8"
            style={{ paddingLeft: 4 + depth * 16 }}
          >
            {depth === 0 ? null : <View className="h-px w-2 bg-foreground/20" />}
            <AssistantAvatar
              assistant={owner.face}
              environmentId={props.environmentId}
              mood={ASSISTANT_GROUP_TASK_MOOD[task.status]}
              size={18}
            />
            <Text className="shrink text-xs font-t3-medium text-foreground" numberOfLines={1}>
              {owner.name}
            </Text>
            <Text className="shrink-0 text-xs text-foreground-muted">{status}</Text>
            <View className="flex-1" />
            <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{duration}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Who works on what: one chip per member with open work, each opening that member's thread. */
export function GroupMemberWorkStrip(
  props: WorkProps & {
    readonly work: ReadonlyArray<AssistantGroupMemberWork>;
    readonly projectName: (projectId: ProjectId) => string;
  },
) {
  const now = useVisibleSecondClock(props.work.length > 0);
  if (props.work.length === 0) return null;
  return (
    <View testID="group-member-work" accessibilityLabel="Members at work">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="flex-row gap-1.5 px-4">
          {props.work.map(({ task, projectId }) => {
            const owner = groupTaskOwner(task, props.members);
            const status = ASSISTANT_GROUP_STATUS_LABEL[task.status];
            const project = projectId === null ? null : props.projectName(projectId);
            const duration = groupTaskDuration(task, now);
            return (
              <Pressable
                key={task.id}
                accessibilityRole="button"
                accessibilityLabel={`${owner.name}, ${status}${project === null ? "" : `, ${project}`}, ${duration}. Open thread`}
                onPress={() => props.onOpenThread(task.threadId)}
                className="h-8 cursor-pointer flex-row items-center gap-1.5 rounded-full border border-foreground/10 bg-foreground/5 pl-1 pr-2.5 active:bg-foreground/10"
              >
                <AssistantAvatar
                  assistant={owner.face}
                  environmentId={props.environmentId}
                  mood={ASSISTANT_GROUP_TASK_MOOD[task.status]}
                  size={22}
                />
                <Text className="text-xs font-t3-medium text-foreground" numberOfLines={1}>
                  {owner.name}
                </Text>
                <Text className="text-xs text-foreground-muted">{status}</Text>
                {project === null ? null : (
                  <Text className="max-w-32 text-xs text-foreground-muted" numberOfLines={1}>
                    {project}
                  </Text>
                )}
                <Text className="text-xs tabular-nums text-foreground-muted">{duration}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
