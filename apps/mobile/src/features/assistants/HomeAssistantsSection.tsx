import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  hasSidebarNotification,
  resolveSidebarThreadStatus,
} from "@t3tools/client-runtime/state/thread-attention";
import type { MenuAction } from "@react-native-menu/menu";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useQuietThreadShell } from "../../state/entities";
import { useAssistantEntries, type AssistantEntry } from "../../state/assistants";
import { SubagentStatusDot } from "../threads/SubagentStatusDot";
import { AssistantAvatar } from "./assistantPresentation";
import { useAssistantFlows } from "./useAssistantFlows";
import { useOpenAssistantEditor } from "./openAssistantEditor";

function AssistantRow(props: {
  readonly entry: AssistantEntry;
  readonly environmentLabel: string | null;
  readonly sidebar: boolean;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const openEditor = useOpenAssistantEditor();
  const thread = useQuietThreadShell(
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId),
  );
  const working = thread !== null && resolveSidebarThreadStatus(thread) === "working";
  const needsYou =
    thread !== null &&
    hasSidebarNotification(
      thread.lastVisitedAt === undefined ? { ...thread, latestRun: null } : thread,
    );
  const actions: MenuAction[] = [
    {
      id: "reset",
      title: "Reset conversation",
      image: "arrow.clockwise",
      attributes: { disabled: !flows.canAct || working },
    },
    { id: "settings", title: `${assistant.name} settings`, image: "gearshape" },
    ...(assistant.isDefault
      ? []
      : [
          {
            id: "archive",
            title: "Archive assistant",
            image: "archivebox",
            attributes: { disabled: !flows.canAct },
          },
        ]),
  ];
  return (
    <Menu
      shouldOpenOnLongPress
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "reset") flows.reset(assistant, { openAfter: true });
        else if (nativeEvent.event === "settings") openEditor(environmentId, assistant);
        else if (nativeEvent.event === "archive") flows.archive(assistant);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${assistant.name}${working ? ", working" : needsYou ? ", needs attention" : ""}`}
        disabled={assistant.threadId === null}
        onPress={() => flows.openConversation(assistant)}
        className="min-h-12 flex-row items-center gap-3 rounded-2xl px-2 active:opacity-70"
      >
        <AssistantAvatar assistant={assistant} />
        <Text
          className={cn(
            "min-w-0 flex-1 text-base font-t3-medium",
            props.sidebar ? "text-drawer-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {assistant.name}
        </Text>
        {props.environmentLabel ? (
          <Text
            className={cn(
              "max-w-[40%] text-xs",
              props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
            )}
            numberOfLines={1}
          >
            {props.environmentLabel}
          </Text>
        ) : null}
        {working ? (
          <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : needsYou ? (
          <SubagentStatusDot tone="completed" placement="sheet" />
        ) : null}
      </Pressable>
    </Menu>
  );
}

/** Pinned above the thread list: one row per active assistant, and a way to add another. */
export function HomeAssistantsSection(props: {
  readonly gutter: number;
  readonly sidebar?: boolean;
  readonly environmentLabelById: ReadonlyMap<string, string>;
}) {
  const { active } = useAssistantEntries();
  const openEditor = useOpenAssistantEditor();
  const sidebar = props.sidebar === true;
  if (active.length === 0) return null;
  const environmentCount = new Set(active.map((entry) => entry.environmentId)).size;
  return (
    <View className="gap-1 pb-3 pt-2" style={{ paddingHorizontal: props.gutter }}>
      <View className="flex-row items-center">
        <Text
          className={cn(
            "flex-1 font-t3-bold text-2xs uppercase tracking-[1.1px]",
            sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary",
          )}
        >
          Assistants
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New assistant"
          hitSlop={8}
          onPress={() => openEditor(active[0]!.environmentId, null)}
          className="size-9 items-center justify-center rounded-full active:opacity-70"
        >
          <SymbolView
            name="person.badge.plus"
            size={18}
            tintColorClassName={sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"}
            type="monochrome"
          />
        </Pressable>
      </View>
      {active.map((entry) => (
        <AssistantRow
          key={`${entry.environmentId}:${entry.assistant.id}`}
          entry={entry}
          sidebar={sidebar}
          environmentLabel={
            environmentCount > 1
              ? (props.environmentLabelById.get(entry.environmentId) ?? null)
              : null
          }
        />
      ))}
    </View>
  );
}
