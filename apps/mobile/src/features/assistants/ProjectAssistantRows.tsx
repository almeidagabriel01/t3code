import { assistantGroupThreadsOf, assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import { projectAssistants } from "@t3tools/client-runtime/assistantSections";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useAssistantEntries, type AssistantEntry } from "../../state/assistants";
import { useQuietThreadShells, useThreadShell } from "../../state/entities";
import { AssistantAvatar } from "./assistantPresentation";
import { moodTextClass } from "./assistantPresenceLabels";
import { useAssistantFlows } from "./useAssistantFlows";

function ProjectAssistantRow(props: { readonly entry: AssistantEntry; readonly sidebar: boolean }) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const thread = useThreadShell(
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId),
  );
  const shells = useQuietThreadShells();
  const presence = assistantPresence(
    thread,
    assistantGroupThreadsOf(shells, environmentId, assistant.id),
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${assistant.name}, ${presence.detail}`}
      disabled={assistant.threadId === null}
      onPress={() => flows.openConversation(assistant)}
      className="min-h-10 flex-row items-center gap-2 rounded-2xl px-2 active:opacity-70"
    >
      <AssistantAvatar
        assistant={assistant}
        environmentId={environmentId}
        mood={presence.mood}
        size={24}
      />
      <Text
        className={cn(
          "shrink-0 text-base font-t3-medium",
          props.sidebar ? "text-drawer-foreground" : "text-foreground",
        )}
        numberOfLines={1}
      >
        {assistant.name}
      </Text>
      <Text
        className={cn("min-w-0 flex-1 text-xs", moodTextClass(presence.mood, props.sidebar))}
        numberOfLines={1}
      >
        {presence.detail}
      </Text>
    </Pressable>
  );
}

/** The project's own assistants, above its threads. Their `assistant:` threads never list as rows. */
export function ProjectAssistantRows(props: {
  readonly members: ReadonlyArray<{ readonly environmentId: string; readonly projectId: string }>;
  readonly gutter: number;
  readonly sidebar?: boolean;
}) {
  const { active } = useAssistantEntries();
  const entries = projectAssistants(active, props.members);
  if (entries.length === 0) return null;
  return (
    <View className="pb-2" style={{ paddingHorizontal: props.gutter }}>
      {entries.map((entry) => (
        <ProjectAssistantRow
          key={`${entry.environmentId}:${entry.assistant.id}`}
          entry={entry}
          sidebar={props.sidebar === true}
        />
      ))}
    </View>
  );
}
