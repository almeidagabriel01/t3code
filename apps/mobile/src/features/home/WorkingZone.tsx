import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { cn } from "../../lib/cn";
import { useWorkingRows } from "../../state/assistants";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

const SHOWN_LIMIT = 5;

/**
 * Assistants, group members and subagents working now, each with who and on which machine.
 * Sits below Needs you on Home and in the tablet sidebar; absent while none work.
 */
export function WorkingZone(props: { readonly gutter: number; readonly sidebar?: boolean }) {
  const rows = useWorkingRows();
  const selectDetail = useSelectWorkspaceDetail();
  const [showAll, setShowAll] = useState(false);
  if (rows.length === 0) return null;
  const sidebar = props.sidebar === true;
  const strong = sidebar ? "text-drawer-foreground" : "text-foreground";
  const muted = sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary";
  const shown = showAll ? rows : rows.slice(0, SHOWN_LIMIT);
  return (
    <View className="pb-3 pt-2" style={{ paddingHorizontal: props.gutter }}>
      <View className="min-h-9 flex-row items-center gap-1.5">
        <Text className={cn("font-t3-bold text-2xs uppercase tracking-[1.1px]", muted)}>
          Working
        </Text>
        <Text className={cn("font-t3-bold text-2xs", muted)}>{rows.length}</Text>
      </View>
      {shown.map(({ item, title, line }) => {
        const { environmentId, threadId, groupId } = item.consumer;
        // By id: an assistant's threads are never in a project list.
        const open = () =>
          threadId !== null
            ? selectDetail({ name: "Thread", params: { environmentId, threadId } })
            : groupId !== null
              ? selectDetail({
                  name: "AssistantGroupChat",
                  params: { environmentId, teamId: groupId },
                })
              : undefined;
        return (
          <Pressable
            key={item.key}
            testID="working-item"
            accessibilityRole="button"
            accessibilityLabel={`${title}, working. ${line}`}
            onPress={open}
            className="min-h-12 flex-row items-center gap-2.5 rounded-2xl px-2 py-1.5 active:opacity-70"
          >
            <AppActivityIndicator size="small" />
            <View className="min-w-0 flex-1">
              <Text className={cn("font-t3-medium text-sm", strong)} numberOfLines={1}>
                {title}
              </Text>
              <Text className={cn("text-xs", muted)} numberOfLines={1}>
                {line}
              </Text>
            </View>
          </Pressable>
        );
      })}
      {rows.length > SHOWN_LIMIT ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll((value) => !value)}
          className="min-h-10 justify-center px-2 active:opacity-70"
        >
          <Text className={cn("text-xs font-t3-medium", muted)}>
            {showAll ? "Show less" : `Show ${rows.length - shown.length} more`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
