import {
  assistantFace,
  assistantGroupThreadsOf,
  assistantPresence,
} from "@t3tools/client-runtime/assistantRobot";
import { projectAssistants } from "@t3tools/client-runtime/assistantSections";
import {
  assistantWorkingHereLabel,
  projectAssistantFaces,
  type AssistantWorkSite,
} from "@t3tools/client-runtime/assistantLiveWork";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import {
  useAssistantEntries,
  useAssistantLiveWork,
  type AssistantEntry,
} from "../../state/assistants";
import { useQuietThreadShells, useThreadShell } from "../../state/entities";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { AssistantAvatar } from "./assistantPresentation";

const FACE_LIMIT = 2;
const FACE_SIZE = 16;

const keyOf = ({ environmentId, assistant }: AssistantEntry) => `${environmentId}:${assistant.id}`;

type ProjectFace = { readonly entry: AssistantEntry; readonly site: AssistantWorkSite | null };

/** A working face wears the work's state, so it matches "is working here" beside it. */
function Face({ entry, site }: ProjectFace) {
  const { assistant, environmentId } = entry;
  const thread = useThreadShell(
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId),
  );
  const shells = useQuietThreadShells();
  const presence = assistantPresence(
    thread,
    assistantGroupThreadsOf(shells, environmentId, assistant.id),
  );
  return (
    <AssistantAvatar
      assistant={assistant}
      environmentId={environmentId}
      mood={site?.face ?? assistantFace(presence)}
      size={FACE_SIZE}
    />
  );
}

/**
 * The project's name with the faces of the assistants working there, then its own assistants.
 * The faces are one 44pt hit area: one assistant opens its conversation, several open a menu to pick.
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
  const shown = faces.slice(0, FACE_LIMIT);
  const more = faces.length - shown.length;
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
      {shown.map((face, index) => (
        <View key={keyOf(face.entry)} style={{ marginLeft: index === 0 ? 0 : -4 }}>
          <Face {...face} />
        </View>
      ))}
      {more > 0 ? (
        <Text
          testID="project-assistant-more"
          className={cn(
            "pl-1 text-2xs font-t3-medium",
            props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted",
          )}
        >
          +{more}
        </Text>
      ) : null}
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
