import { assistantProjectsChip } from "@t3tools/client-runtime/assistantSections";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  assistantMetaLabel,
  rankAssistants,
  visibleAssistants,
} from "@t3tools/client-runtime/assistantList";
import {
  assistantFace,
  assistantGroupThreadsOf,
  assistantPresence,
} from "@t3tools/client-runtime/assistantRobot";
import {
  hasSidebarNotification,
  resolveSidebarThreadStatus,
} from "@t3tools/client-runtime/state/thread-attention";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import {
  useAssistantEntries,
  type AssistantEntry,
  type AssistantTeamEntry,
} from "../../state/assistants";
import { SubagentStatusDot } from "../threads/SubagentStatusDot";
import { AssistantAvatar } from "./assistantPresentation";
import { AssistantTaskRows } from "./AssistantTaskRows";
import { moodTextClass } from "./assistantPresenceLabels";
import { useAssistantFlows, useAssistantTeamFlows } from "./useAssistantFlows";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useOpenAssistantWork } from "./assistantWorkTarget";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useHomeSectionPreferences } from "../home/useHomeSectionPreferences";

const COLLAPSED_AVATAR_LIMIT = 5;
const STACKED_AVATAR_LIMIT = 4;

const threadRefOf = ({ assistant, environmentId }: AssistantEntry) =>
  assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId);

function useAssistantState(entry: AssistantEntry) {
  const thread = useThreadShell(threadRefOf(entry));
  const shells = useQuietThreadShells();
  const presence = assistantPresence(
    thread,
    assistantGroupThreadsOf(shells, entry.environmentId, entry.assistant.id),
  );
  return {
    presence,
    working:
      (thread !== null && resolveSidebarThreadStatus(thread) === "working") ||
      presence.mood === "working",
    needsYou:
      presence.mood === "needs" ||
      (thread !== null &&
        hasSidebarNotification(
          thread.lastVisitedAt === undefined ? { ...thread, latestRun: null } : thread,
        )),
  };
}

function statusLabel(name: string, state: { working: boolean; needsYou: boolean }) {
  return `${name}${state.working ? ", working" : state.needsYou ? ", needs attention" : ""}`;
}

/** Collapsed header: the avatar alone, with a dot when the assistant works or wants you. */
function AssistantAvatarButton(props: { readonly entry: AssistantEntry }) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const state = useAssistantState(props.entry);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={statusLabel(assistant.name, state)}
      disabled={assistant.threadId === null}
      hitSlop={4}
      onPress={() => flows.openConversation(assistant)}
      className="active:opacity-70"
    >
      <AssistantAvatar
        assistant={assistant}
        environmentId={environmentId}
        mood={assistantFace(state.presence)}
        size={28}
      />
      {state.working || state.needsYou ? (
        <View className="absolute -right-0.5 -top-0.5">
          <SubagentStatusDot tone={state.working ? "working" : "completed"} placement="sheet" />
        </View>
      ) : null}
    </Pressable>
  );
}

function RowMenuButton(props: {
  readonly label: string;
  readonly sidebar: boolean;
  readonly actions: MenuAction[];
  readonly onAction: (id: string) => void;
}) {
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        hitSlop={6}
        className="size-9 items-center justify-center rounded-full active:opacity-70"
      >
        <SymbolView
          name="ellipsis"
          size={16}
          tintColorClassName={
            props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"
          }
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

function AssistantRow(props: {
  readonly entry: AssistantEntry;
  readonly environmentLabel: string | null;
  readonly sidebar: boolean;
  readonly nested?: boolean;
  /** Shown as a pill when the assistant is project-scoped and has no status to show. */
  readonly projectLabel?: string | null;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const openEditor = useOpenAssistantEditor();
  const openWork = useOpenAssistantWork();
  const state = useAssistantState(props.entry);
  const { presence } = state;
  const meta = assistantMetaLabel(presence);
  const muted = props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const actions: MenuAction[] = [
    {
      id: "reset",
      title: "Reset conversation",
      image: "arrow.clockwise",
      attributes: { disabled: !flows.canAct || state.working },
    },
    { id: "work", title: `${assistant.name} work`, image: "briefcase" },
    { id: "settings", title: `${assistant.name} settings`, image: "gearshape" },
    {
      id: "archive",
      title: "Archive assistant",
      image: "archivebox",
      attributes: { disabled: !flows.canAct },
    },
  ];
  return (
    <View>
      <View
        className={cn(
          "flex-row items-center",
          props.nested && "ml-3.5 border-l border-border pl-1",
        )}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={statusLabel(assistant.name, state)}
          disabled={assistant.threadId === null}
          onPress={() => flows.openConversation(assistant)}
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-2xl px-2 active:opacity-70"
        >
          <View>
            <AssistantAvatar
              assistant={assistant}
              environmentId={environmentId}
              mood={assistantFace(presence)}
              size={24}
            />
            {state.working || state.needsYou ? (
              <View className="absolute -right-0.5 -top-0.5">
                <SubagentStatusDot
                  tone={state.working ? "working" : "completed"}
                  placement="sheet"
                />
              </View>
            ) : null}
          </View>
          <Text
            className={cn(
              "shrink text-base font-t3-medium",
              props.sidebar ? "text-drawer-foreground" : "text-foreground",
            )}
            numberOfLines={1}
          >
            {assistant.name}
          </Text>
          {assistant.role === "" ? null : (
            <View className="max-w-20 rounded-md border border-border px-1.5 py-px">
              <Text className={cn("text-2xs", muted)} numberOfLines={1}>
                {assistant.role}
              </Text>
            </View>
          )}
          {props.environmentLabel ? (
            <Text className={cn("max-w-[25%] text-xs", muted)} numberOfLines={1}>
              {props.environmentLabel}
            </Text>
          ) : null}
          <View className="min-w-2 flex-1" />
          {meta !== null ? (
            <Text
              testID="assistant-status"
              className={cn(
                "max-w-[45%] shrink text-xs",
                moodTextClass(presence.mood, props.sidebar),
              )}
              numberOfLines={1}
            >
              {meta}
            </Text>
          ) : props.projectLabel ? (
            <View
              testID="assistant-project"
              className="max-w-24 rounded-md border border-border px-1.5 py-px"
            >
              <Text className={cn("text-2xs", muted)} numberOfLines={1}>
                {props.projectLabel}
              </Text>
            </View>
          ) : null}
        </Pressable>
        <RowMenuButton
          label={`${assistant.name} actions`}
          sidebar={props.sidebar}
          actions={actions}
          onAction={(id) => {
            if (id === "reset") flows.reset(assistant, { openAfter: true });
            else if (id === "work") openWork(environmentId, assistant.id);
            else if (id === "settings") openEditor(environmentId, assistant);
            else if (id === "archive") flows.archive(assistant);
          }}
        />
      </View>
      <AssistantTaskRows entry={props.entry} sidebar={props.sidebar} />
    </View>
  );
}

/** One group on one line: the row opens its chat; the chevron shows or hides its members. */
function GroupFoldRow(props: {
  readonly entry: AssistantTeamEntry;
  readonly members: ReadonlyArray<AssistantEntry>;
  readonly running: number;
  readonly expanded: boolean;
  readonly sidebar: boolean;
  readonly onToggle: () => void;
}) {
  const openTeam = useOpenAssistantTeam();
  const openEditor = useOpenAssistantEditor();
  const flows = useAssistantTeamFlows(props.entry.environmentId);
  const { environmentId, team } = props.entry;
  const shown = props.members.slice(0, STACKED_AVATAR_LIMIT);
  const more = props.members.length - shown.length;
  const unread = team.chat?.unreadCount ?? 0;
  const mutedIcon = props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle";
  const muted = props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted";
  return (
    <View className="flex-row items-center">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={team.name}
        onPress={() => openTeam.chat(environmentId, team.id)}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 px-2 active:opacity-70"
      >
        <SymbolView
          name="bubble.left.and.bubble.right"
          size={14}
          tintColorClassName={mutedIcon}
          type="monochrome"
        />
        <Text
          className={cn(
            "shrink text-base font-t3-medium",
            props.sidebar ? "text-drawer-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {team.name}
        </Text>
        {/* The narrow tablet bar drops the faces while the group runs, so its name stays whole. */}
        {props.sidebar && props.running > 0 ? null : (
          <View testID="group-avatars" className="flex-row items-center pl-0.5">
            {shown.map(({ assistant }, index) => (
              <View key={assistant.id} style={{ marginLeft: index === 0 ? 0 : -6 }}>
                <AssistantAvatar assistant={assistant} environmentId={environmentId} size={16} />
              </View>
            ))}
            {more > 0 ? <Text className="pl-1 text-2xs text-foreground-muted">+{more}</Text> : null}
          </View>
        )}
        <View className="min-w-2 flex-1" />
        {unread > 0 ? (
          <View
            testID="group-unread"
            accessibilityLabel={`${unread} unread`}
            className="min-w-5 items-center rounded-full bg-primary px-1.5 py-px"
          >
            <Text className="text-2xs font-t3-bold text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </Text>
          </View>
        ) : null}
        {props.running > 0 ? (
          <View testID="group-status" className="flex-row items-center gap-1">
            <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
            <Text className={cn("text-xs", muted)}>{props.running} running</Text>
          </View>
        ) : props.members.length === 0 ? (
          <Text testID="group-status" className={cn("text-xs", muted)}>
            empty
          </Text>
        ) : null}
      </Pressable>
      {props.members.length === 0 ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.expanded ? "Hide" : "Show"} ${team.name} members`}
          accessibilityState={{ expanded: props.expanded }}
          hitSlop={6}
          onPress={props.onToggle}
          className="size-9 items-center justify-center rounded-full active:opacity-70"
        >
          <SymbolView
            name={props.expanded ? "chevron.down" : "chevron.right"}
            size={11}
            tintColorClassName={mutedIcon}
            type="monochrome"
          />
        </Pressable>
      )}
      <RowMenuButton
        label={`${team.name} actions`}
        sidebar={props.sidebar}
        actions={[
          { id: "chat", title: "Open chat", image: "bubble.left.and.bubble.right" },
          unread > 0
            ? {
                id: "read",
                title: "Mark as read",
                image: "envelope.open",
                attributes: { disabled: !flows.canMarkRead },
              }
            : {
                id: "unread",
                title: "Mark as unread",
                image: "envelope.badge",
                attributes: { disabled: !flows.canMarkRead || (team.chat?.latestSeq ?? 0) === 0 },
              },
          { id: "edit", title: "Edit group", image: "pencil" },
          { id: "new", title: "New assistant in this group", image: "plus" },
          {
            id: "archive",
            title: "Archive group",
            image: "archivebox",
            attributes: { disabled: !flows.canAct },
          },
        ]}
        onAction={(id) => {
          if (id === "chat") openTeam.chat(environmentId, team.id);
          else if (id === "read") void flows.markRead(team);
          else if (id === "unread") void flows.markUnread(team);
          else if (id === "edit") openTeam.edit(environmentId, team.id);
          else if (id === "new") openEditor(environmentId, null, { teamId: team.id });
          else if (id === "archive") flows.archive(team);
        }}
      />
    </View>
  );
}

/** Pinned above the thread list: what needs the user, then groups, projects and the rest. */
export function HomeAssistantsSection(props: {
  readonly gutter: number;
  readonly sidebar?: boolean;
  readonly environmentLabelById: ReadonlyMap<string, string>;
}) {
  const { active, activeTeams: teams } = useAssistantEntries();
  const navigation = useNavigation();
  const openEditor = useOpenAssistantEditor();
  const openTeam = useOpenAssistantTeam();
  const { assistantsCollapsed, toggleAssistants, assistantsShowAll, toggleAssistantsShowAll } =
    useHomeSectionPreferences();
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const sidebar = props.sidebar === true;
  if (active.length === 0 && teams.length === 0) return null;
  const environmentId = active[0]?.environmentId ?? teams[0]!.environmentId;
  const toggleExpanded = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const ranked = rankAssistants(active, shells);
  const rankedByKey = new Map(
    ranked.map((item) => [`${item.entry.environmentId}:${item.entry.assistant.id}`, item]),
  );
  const { shown: listed, hidden: hiddenInList } = visibleAssistants(ranked, assistantsShowAll);
  const foldable = assistantsShowAll || hiddenInList > 0;
  const projectName = (envId: string, projectId: string) =>
    projects.find((project) => project.environmentId === envId && project.id === projectId)
      ?.title ?? "Project";
  const environmentCount = new Set(active.map((entry) => entry.environmentId)).size;
  const row = (entry: AssistantEntry, nested = false) => (
    <AssistantRow
      key={`${entry.environmentId}:${entry.assistant.id}`}
      entry={entry}
      sidebar={sidebar}
      nested={nested}
      environmentLabel={
        environmentCount > 1 ? (props.environmentLabelById.get(entry.environmentId) ?? null) : null
      }
      projectLabel={assistantProjectsChip(entry.assistant, (projectId) =>
        projectName(entry.environmentId, projectId),
      )}
    />
  );
  const mutedIcon = sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle";
  const shown = ranked.slice(0, COLLAPSED_AVATAR_LIMIT);
  const hidden = ranked.length - shown.length;
  const addActions: MenuAction[] = [
    { id: "assistant", title: "New assistant", image: "person.badge.plus" },
    { id: "group", title: "New group", image: "person.2" },
    { id: "describe", title: "Describe one and let T3 build it", image: "text.bubble" },
  ];

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
            tintColorClassName={mutedIcon}
            type="monochrome"
          />
        </Pressable>
        <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2 pr-1">
          {assistantsCollapsed ? (
            <>
              {shown.map(({ entry }) => (
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
        <Menu
          actions={addActions}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "assistant") openEditor(environmentId, null);
            else if (nativeEvent.event === "group") openTeam.edit(environmentId, null);
            else if (nativeEvent.event === "describe")
              navigation.navigate("SettingsAssistantDescribe");
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add"
            hitSlop={8}
            className="size-9 items-center justify-center rounded-full active:opacity-70"
          >
            <SymbolView name="plus" size={18} tintColorClassName={mutedIcon} type="monochrome" />
          </Pressable>
        </Menu>
      </View>
      {assistantsCollapsed ? null : (
        <>
          {teams.map((team) => {
            const key = `group:${team.environmentId}:${team.team.id}`;
            const members = team.team.memberIds.flatMap((id) => {
              const item = rankedByKey.get(`${team.environmentId}:${id}`);
              return item === undefined ? [] : [item];
            });
            return (
              <View key={key}>
                <GroupFoldRow
                  entry={team}
                  members={members.map((item) => item.entry)}
                  running={members.filter((item) => item.presence.mood === "working").length}
                  expanded={expanded.has(key)}
                  sidebar={sidebar}
                  onToggle={() => toggleExpanded(key)}
                />
                {expanded.has(key) ? members.map((item) => row(item.entry, true)) : null}
              </View>
            );
          })}
          {listed.map((item) => row(item.entry))}
          {foldable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={assistantsShowAll ? "Show less" : "Show all"}
              onPress={toggleAssistantsShowAll}
              className="min-h-10 justify-center px-2 active:opacity-70"
            >
              <Text
                className={cn(
                  "text-xs font-t3-medium",
                  sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary",
                )}
              >
                {assistantsShowAll ? "Show less" : `Show all (${ranked.length})`}
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}
