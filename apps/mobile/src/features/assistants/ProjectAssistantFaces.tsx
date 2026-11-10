import {
  assistantFace,
  assistantGroupThreadsOf,
  assistantPresence,
} from "@t3tools/client-runtime/assistantRobot";
import { projectAssistants } from "@t3tools/client-runtime/assistantSections";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useAssistantEntries, type AssistantEntry } from "../../state/assistants";
import { useQuietThreadShells, useThreadShell } from "../../state/entities";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { AssistantAvatar } from "./assistantPresentation";

const FACE_LIMIT = 2;
const FACE_SIZE = 16;

const keyOf = ({ environmentId, assistant }: AssistantEntry) => `${environmentId}:${assistant.id}`;

function Face({ entry }: { readonly entry: AssistantEntry }) {
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
      mood={assistantFace(presence)}
      size={FACE_SIZE}
    />
  );
}

/**
 * The project's name with its assistants as small faces beside it (nothing when it has none).
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
  const selectDetail = useSelectWorkspaceDetail();
  const entries = projectAssistants(active, props.members);
  if (entries.length === 0) return null;
  const open = ({ assistant, environmentId }: AssistantEntry) => {
    if (assistant.threadId === null) return;
    selectDetail({
      name: "Thread",
      params: { environmentId: String(environmentId), threadId: String(assistant.threadId) },
    });
  };
  const shown = entries.slice(0, FACE_LIMIT);
  const more = entries.length - shown.length;
  const label = `${entries.map(({ assistant }) => assistant.name).join(", ")}: assistants in this project`;
  const cluster = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={entries.length === 1 && entries[0]!.assistant.threadId === null}
      onPress={entries.length === 1 ? () => open(entries[0]!) : undefined}
      className="min-h-11 min-w-11 flex-row items-center justify-center rounded-2xl px-2 active:opacity-70"
    >
      {shown.map((entry, index) => (
        <View key={keyOf(entry)} style={{ marginLeft: index === 0 ? 0 : -4 }}>
          <Face entry={entry} />
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
      {entries.length === 1 ? (
        cluster
      ) : (
        <Menu
          actions={entries.map((entry) => ({
            id: keyOf(entry),
            title: entry.assistant.name,
            attributes: { disabled: entry.assistant.threadId === null },
          }))}
          onPressAction={({ nativeEvent }) => {
            const entry = entries.find((candidate) => keyOf(candidate) === nativeEvent.event);
            if (entry !== undefined) open(entry);
          }}
        >
          {cluster}
        </Menu>
      )}
    </View>
  );
}
