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
import {
  useAssistantEntries,
  type AssistantEntry,
  type AssistantTeamEntry,
} from "../../state/assistants";
import { SubagentStatusDot } from "../threads/SubagentStatusDot";
import { AssistantAvatar } from "./assistantPresentation";
import { useAssistantFlows } from "./useAssistantFlows";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useHomeSectionPreferences } from "../home/useHomeSectionPreferences";

const COLLAPSED_AVATAR_LIMIT = 5;

function useAssistantStatus({ assistant, environmentId }: AssistantEntry) {
  const thread = useQuietThreadShell(
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId),
  );
  const working = thread !== null && resolveSidebarThreadStatus(thread) === "working";
  const needsYou =
    thread !== null &&
    hasSidebarNotification(
      thread.lastVisitedAt === undefined ? { ...thread, latestRun: null } : thread,
    );
  return { working, needsYou } as const;
}

function statusLabel(name: string, status: { working: boolean; needsYou: boolean }) {
  return `${name}${status.working ? ", working" : status.needsYou ? ", needs attention" : ""}`;
}

/** Collapsed header: the avatar alone, with a dot when the assistant works or wants you. */
function AssistantAvatarButton(props: { readonly entry: AssistantEntry }) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const status = useAssistantStatus(props.entry);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={statusLabel(assistant.name, status)}
      disabled={assistant.threadId === null}
      hitSlop={4}
      onPress={() => flows.openConversation(assistant)}
      className="active:opacity-70"
    >
      <AssistantAvatar assistant={assistant} size={28} />
      {status.working || status.needsYou ? (
        <View className="absolute -right-0.5 -top-0.5">
          <SubagentStatusDot tone={status.working ? "working" : "completed"} placement="sheet" />
        </View>
      ) : null}
    </Pressable>
  );
}

function AssistantRow(props: {
  readonly entry: AssistantEntry;
  readonly environmentLabel: string | null;
  readonly sidebar: boolean;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const openEditor = useOpenAssistantEditor();
  const { working, needsYou } = useAssistantStatus(props.entry);
  const actions: MenuAction[] = [
    {
      id: "reset",
      title: "Reset conversation",
      image: "arrow.clockwise",
      attributes: { disabled: !flows.canAct || working },
    },
    { id: "settings", title: `${assistant.name} settings`, image: "gearshape" },
    {
      id: "archive",
      title: "Archive assistant",
      image: "archivebox",
      attributes: { disabled: !flows.canAct },
    },
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
        accessibilityLabel={statusLabel(assistant.name, { working, needsYou })}
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

function TeamRow(props: { readonly entry: AssistantTeamEntry; readonly sidebar: boolean }) {
  const openTeam = useOpenAssistantTeam();
  const { team, environmentId } = props.entry;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${team.name} team, ${team.memberIds.length} members`}
      onPress={() => openTeam.activity(environmentId, team.id)}
      className="min-h-12 flex-row items-center gap-3 rounded-2xl px-2 active:opacity-70"
    >
      <SymbolView
        name="person.2"
        size={18}
        tintColorClassName={props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"}
        type="monochrome"
      />
      <Text
        className={cn(
          "min-w-0 flex-1 text-base font-t3-medium",
          props.sidebar ? "text-drawer-foreground" : "text-foreground",
        )}
        numberOfLines={1}
      >
        {team.name}
      </Text>
      <Text
        className={cn(
          "text-xs",
          props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
        )}
      >
        {team.memberIds.length}
      </Text>
    </Pressable>
  );
}

/** Pinned above the thread list: one row per active assistant, and a way to add another. */
export function HomeAssistantsSection(props: {
  readonly gutter: number;
  readonly sidebar?: boolean;
  readonly environmentLabelById: ReadonlyMap<string, string>;
}) {
  const { active, teams } = useAssistantEntries();
  const openEditor = useOpenAssistantEditor();
  const { assistantsCollapsed, toggleAssistants } = useHomeSectionPreferences();
  const sidebar = props.sidebar === true;
  if (active.length === 0) return null;
  const shown = active.slice(0, COLLAPSED_AVATAR_LIMIT);
  const hidden = active.length - shown.length;
  const environmentCount = new Set(active.map((entry) => entry.environmentId)).size;
  return (
    <View className="gap-1 pb-3 pt-2" style={{ paddingHorizontal: props.gutter }}>
      <View className="flex-row items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Assistants"
          accessibilityState={{ expanded: !assistantsCollapsed }}
          hitSlop={8}
          onPress={toggleAssistants}
          className="min-h-9 flex-row items-center gap-1 active:opacity-70"
        >
          <Text
            className={cn(
              "font-t3-bold text-2xs uppercase tracking-[1.1px]",
              sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary",
            )}
          >
            Assistants
          </Text>
          <SymbolView
            name={assistantsCollapsed ? "chevron.right" : "chevron.down"}
            size={11}
            tintColorClassName={sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"}
            type="monochrome"
          />
        </Pressable>
        <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2 pr-1">
          {assistantsCollapsed ? (
            <>
              {shown.map((entry) => (
                <AssistantAvatarButton
                  key={`${entry.environmentId}:${entry.assistant.id}`}
                  entry={entry}
                />
              ))}
              {hidden > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${hidden} more assistants`}
                  hitSlop={4}
                  onPress={toggleAssistants}
                  className="active:opacity-70"
                >
                  <Text
                    className={cn(
                      "text-xs font-t3-medium",
                      sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary",
                    )}
                  >
                    +{hidden}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
        </View>
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
      {assistantsCollapsed
        ? null
        : active.map((entry) => (
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
      {assistantsCollapsed
        ? null
        : teams.map((entry) => (
            <TeamRow
              key={`${entry.environmentId}:${entry.team.id}`}
              entry={entry}
              sidebar={sidebar}
            />
          ))}
    </View>
  );
}
