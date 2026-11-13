import { assistantFace, assistantPresenceOf } from "@t3tools/client-runtime/assistantRobot";
import { projectAssistants } from "@t3tools/client-runtime/assistantSections";
import {
  assistantWorkingHereLabel,
  projectAssistantFaces,
  type AssistantWorkSite,
} from "@t3tools/client-runtime/assistantLiveWork";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import {
  useAssistantEntries,
  useAssistantLiveWork,
  type AssistantEntry,
} from "../../state/assistants";
import { useQuietThreadShells } from "../../state/entities";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { AssistantCluster } from "./assistantPresentation";

const CLUSTER_SIZE = 20;

const keyOf = ({ environmentId, assistant }: AssistantEntry) => `${environmentId}:${assistant.id}`;

type ProjectFace = { readonly entry: AssistantEntry; readonly site: AssistantWorkSite | null };

/**
 * The project's name with one cluster of the assistants working there, then its own assistants.
 * The cluster is one 44pt hit area: one assistant opens its conversation, several open a menu to pick.
 * Uses `useSelectWorkspaceDetail`, not `useRoute`, so the tablet sidebar can render it.
 */
export function ProjectAssistantFaces(props: {
  readonly title: string;
  readonly members: ReadonlyArray<{ readonly environmentId: string; readonly projectId: string }>;
  readonly gutter: number;
  readonly sidebar?: boolean;
}) {
  const { active } = useAssistantEntries();
  const { sites } = useAssistantLiveWork();
  const selectDetail = useSelectWorkspaceDetail();
  const shells = useQuietThreadShells();
  const faces = projectAssistantFaces({
    assistants: active,
    configured: projectAssistants(active, props.members),
    sites,
    members: props.members,
  });
  if (faces.length === 0) return null;
  const threadOf = ({ entry, site }: ProjectFace) => site?.threadId ?? entry.assistant.threadId;
  const open = (face: ProjectFace) => {
    const threadId = threadOf(face);
    if (threadId === null) return;
    selectDetail({
      name: "Thread",
      params: { environmentId: String(face.entry.environmentId), threadId: String(threadId) },
    });
  };
  const titleOf = ({ entry, site }: ProjectFace) =>
    site === null ? entry.assistant.name : assistantWorkingHereLabel(entry.assistant.name);
  const label = faces.some((face) => face.site !== null)
    ? faces.map(titleOf).join(", ")
    : `${faces.map(titleOf).join(", ")}: assistants in this project`;
  const cluster = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={faces.length === 1 && threadOf(faces[0]!) === null}
      onPress={faces.length === 1 ? () => open(faces[0]!) : undefined}
      className="min-h-11 min-w-11 flex-row items-center justify-center rounded-2xl px-2 active:opacity-70"
    >
      <AssistantCluster
        size={CLUSTER_SIZE}
        environmentId={faces[0]!.entry.environmentId}
        faces={faces.map(({ entry, site }) => ({
          key: keyOf(entry),
          assistant: entry.assistant,
          // A working face wears the work's state, so it matches "is working here" in the label.
          mood:
            site?.face ??
            assistantFace(assistantPresenceOf(entry.assistant, entry.environmentId, shells)),
        }))}
      />
    </Pressable>
  );
  return (
    <View className="flex-row items-center" style={{ paddingHorizontal: props.gutter }}>
      <Text
        className={cn(
          "shrink text-base font-t3-medium",
          props.sidebar ? "text-drawer-foreground" : "text-foreground",
        )}
        numberOfLines={1}
      >
        {props.title}
      </Text>
      {faces.length === 1 ? (
        cluster
      ) : (
        <Menu
          actions={faces.map((face) => ({
            id: keyOf(face.entry),
            title: titleOf(face),
            attributes: { disabled: threadOf(face) === null },
          }))}
          onPressAction={({ nativeEvent }) => {
            const face = faces.find((candidate) => keyOf(candidate.entry) === nativeEvent.event);
            if (face !== undefined) open(face);
          }}
        >
          {cluster}
        </Menu>
      )}
    </View>
  );
}
