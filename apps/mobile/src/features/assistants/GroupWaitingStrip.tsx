import {
  assistantGroupWaitingWhy,
  type AssistantGroupWaitingItem,
} from "@t3tools/client-runtime/assistantGroupChat";
import type { Assistant, AssistantGroupTask, EnvironmentId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { AssistantAvatar, removedAssistantFace } from "./assistantPresentation";

/** The requests that wait on the user in this tab, each one tap from its place in the feed. */
export function GroupWaitingStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<AssistantGroupWaitingItem>;
  /** The group's current members, by id: anyone else shows as a removed member. */
  readonly members: ReadonlyMap<string, Assistant>;
  readonly lead: Assistant | undefined;
  /** False in an archived group or without permission: no Resume. */
  readonly canResume: boolean;
  readonly onOpen: (requestId: AssistantGroupWaitingItem["requestId"]) => void;
  readonly onResume: (task: AssistantGroupTask) => void;
}) {
  if (props.items.length === 0) return null;
  const heading = `Waiting on you (${props.items.length})`;
  return (
    <View testID="group-waiting-strip" accessibilityLabel={heading} className="gap-0.5 px-4">
      <View className="flex-row items-center gap-1.5">
        <SymbolView name="hourglass" size={12} tintColorClassName="accent-warning-foreground" />
        <Text className="text-xs font-t3-medium text-warning-foreground">{heading}</Text>
      </View>
      <ScrollView className="max-h-[96px]" showsVerticalScrollIndicator={false}>
        {props.items.map((item) => {
          const id = item.assistantId ?? props.lead?.id;
          const member = id === undefined ? undefined : props.members.get(id);
          const name = member?.name ?? "Removed member";
          const why = assistantGroupWaitingWhy({
            reason: item.reason,
            taskReason: item.task?.reason ?? null,
          });
          return (
            <View key={item.requestId} className="min-h-11 flex-row items-center gap-1">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.title}. ${name}: ${why}. Open request`}
                onPress={() => props.onOpen(item.requestId)}
                className="min-w-0 flex-1 cursor-pointer flex-row items-center gap-2 rounded-lg py-1 pr-1 active:bg-foreground/8"
              >
                {id === undefined ? null : (
                  <AssistantAvatar
                    assistant={member ?? removedAssistantFace(id)}
                    environmentId={props.environmentId}
                    mood="needs"
                    size={22}
                  />
                )}
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {`${name} · ${why}`}
                  </Text>
                </View>
              </Pressable>
              {item.task === null || !props.canResume ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Resume ${item.title}`}
                  hitSlop={6}
                  onPress={() => props.onResume(item.task!)}
                  className="h-8 cursor-pointer flex-row items-center gap-1 rounded-full bg-foreground/6 px-3 active:bg-foreground/12"
                >
                  <SymbolView name="play" size={11} tintColorClassName="accent-icon-subtle" />
                  <Text className="text-xs font-t3-medium text-foreground">Resume</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
