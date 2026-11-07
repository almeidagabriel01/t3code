import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import { assistantEntryKey, assistantSections } from "@t3tools/client-runtime/assistantSections";
import {
  hasSidebarNotification,
  resolveSidebarThreadStatus,
} from "@t3tools/client-runtime/state/thread-attention";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import {
  useAssistantEntries,
  type AssistantEntry,
  type AssistantTeamEntry,
} from "../../state/assistants";
import { SubagentStatusDot } from "../threads/SubagentStatusDot";
import { AssistantAvatar } from "./assistantPresentation";
import { moodTextClass } from "./assistantPresenceLabels";
import { useAssistantFlows } from "./useAssistantFlows";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useHomeSectionPreferences } from "../home/useHomeSectionPreferences";

const COLLAPSED_AVATAR_LIMIT = 5;
const STACKED_AVATAR_LIMIT = 4;

const threadRefOf = ({ assistant, environmentId }: AssistantEntry) =>
  assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId);

function useAssistantState(entry: AssistantEntry) {
  const thread = useThreadShell(threadRefOf(entry));
  return {
    presence: assistantPresence(thread),
    working: thread !== null && resolveSidebarThreadStatus(thread) === "working",
    needsYou:
      thread !== null &&
      hasSidebarNotification(
        thread.lastVisitedAt === undefined ? { ...thread, latestRun: null } : thread,
      ),
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
        mood={state.presence.mood}
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
  readonly nowMs: number;
  readonly nested?: boolean;
  /** Named in the status line when the assistant is listed somewhere other than its project. */
  readonly projectLabel?: string | null;
}) {
  const { assistant, environmentId } = props.entry;
  const flows = useAssistantFlows(environmentId);
  const openEditor = useOpenAssistantEditor();
  const state = useAssistantState(props.entry);
  const { presence } = state;
  const actions: MenuAction[] = [
    {
      id: "reset",
      title: "Reset conversation",
      image: "arrow.clockwise",
      attributes: { disabled: !flows.canAct || state.working },
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
    <View
      className={cn("flex-row items-center", props.nested && "ml-3.5 border-l border-border pl-1")}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={statusLabel(assistant.name, state)}
        disabled={assistant.threadId === null}
        onPress={() => flows.openConversation(assistant)}
        className="min-h-12 min-w-0 flex-1 flex-row items-center gap-3 rounded-2xl px-2 active:opacity-70"
      >
        <AssistantAvatar
          assistant={assistant}
          environmentId={environmentId}
          mood={presence.mood}
          size={32}
        />
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-1.5">
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
              <View className="max-w-24 rounded-md border border-border px-1.5 py-px">
                <Text
                  className={cn(
                    "text-2xs",
                    props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted",
                  )}
                  numberOfLines={1}
                >
                  {assistant.role}
                </Text>
              </View>
            )}
            {props.environmentLabel ? (
              <Text
                className={cn(
                  "max-w-[30%] text-xs",
                  props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
                )}
                numberOfLines={1}
              >
                {props.environmentLabel}
              </Text>
            ) : null}
          </View>
          <Text
            testID="assistant-status"
            className={cn("text-xs", moodTextClass(presence.mood, props.sidebar))}
            numberOfLines={1}
          >
            {props.projectLabel ? `${props.projectLabel} only · ` : ""}
            {presence.detail}
            {presence.since === null ? "" : ` · ${relativeTime(presence.since, props.nowMs)}`}
          </Text>
        </View>
        {state.working ? (
          <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : state.needsYou ? (
          <SubagentStatusDot tone="completed" placement="sheet" />
        ) : null}
      </Pressable>
      <RowMenuButton
        label={`${assistant.name} actions`}
        sidebar={props.sidebar}
        actions={actions}
        onAction={(id) => {
          if (id === "reset") flows.reset(assistant, { openAfter: true });
          else if (id === "settings") openEditor(environmentId, assistant);
          else if (id === "archive") flows.archive(assistant);
        }}
      />
    </View>
  );
}

/** A group or project header: folds its members, shows what it holds, and carries its menu. */
function FoldRow(props: {
  readonly label: string;
  readonly folded: boolean;
  readonly sidebar: boolean;
  readonly onToggle: () => void;
  readonly leading: ReactNode;
  readonly trailing?: ReactNode;
  readonly menuLabel: string;
  readonly actions: MenuAction[];
  readonly onAction: (id: string) => void;
}) {
  return (
    <View className="flex-row items-center">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={{ expanded: !props.folded }}
        onPress={props.onToggle}
        className="min-h-10 min-w-0 flex-1 flex-row items-center gap-2 px-2 active:opacity-70"
      >
        <SymbolView
          name={props.folded ? "chevron.right" : "chevron.down"}
          size={11}
          tintColorClassName={
            props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"
          }
          type="monochrome"
        />
        {props.leading}
        <Text
          className={cn(
            "shrink text-base font-t3-bold",
            props.sidebar ? "text-drawer-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {props.label}
        </Text>
        {props.trailing}
      </Pressable>
      <RowMenuButton
        label={props.menuLabel}
        sidebar={props.sidebar}
        actions={props.actions}
        onAction={props.onAction}
      />
    </View>
  );
}

function SectionLabel(props: { readonly children: string; readonly tone?: string }) {
  return (
    <Text className={cn("px-2 pb-0.5 pt-2 text-xs font-t3-medium", props.tone)}>
      {props.children}
    </Text>
  );
}

function GroupFoldRow(props: {
  readonly entry: AssistantTeamEntry;
  readonly members: ReadonlyArray<AssistantEntry>;
  readonly folded: boolean;
  readonly sidebar: boolean;
  readonly onToggle: () => void;
}) {
  const openTeam = useOpenAssistantTeam();
  const openEditor = useOpenAssistantEditor();
  const { environmentId, team } = props.entry;
  const shown = props.members.slice(0, STACKED_AVATAR_LIMIT);
  const more = props.members.length - shown.length;
  return (
    <FoldRow
      label={team.name}
      folded={props.folded}
      sidebar={props.sidebar}
      onToggle={props.onToggle}
      leading={
        <SymbolView
          name="person.2"
          size={16}
          tintColorClassName={
            props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"
          }
          type="monochrome"
        />
      }
      trailing={
        <View testID="group-avatars" className="flex-row items-center pl-0.5">
          {shown.map(({ assistant }, index) => (
            <View key={assistant.id} style={{ marginLeft: index === 0 ? 0 : -6 }}>
              <AssistantAvatar assistant={assistant} environmentId={environmentId} size={18} />
            </View>
          ))}
          {more > 0 ? <Text className="pl-1 text-2xs text-foreground-muted">+{more}</Text> : null}
        </View>
      }
      menuLabel={`${team.name} actions`}
      actions={[
        { id: "edit", title: "Edit group", image: "pencil" },
        { id: "activity", title: "Team activity", image: "person.2" },
        { id: "new", title: "New assistant in this group", image: "plus" },
      ]}
      onAction={(id) => {
        if (id === "edit") openTeam.edit(environmentId, team.id);
        else if (id === "activity") openTeam.activity(environmentId, team.id);
        else if (id === "new") openEditor(environmentId, null, { teamId: team.id });
      }}
    />
  );
}

/** Pinned above the thread list: what needs the user, then groups, projects and the rest. */
export function HomeAssistantsSection(props: {
  readonly gutter: number;
  readonly sidebar?: boolean;
  readonly environmentLabelById: ReadonlyMap<string, string>;
}) {
  const { active, teams } = useAssistantEntries();
  const navigation = useNavigation();
  const openEditor = useOpenAssistantEditor();
  const openTeam = useOpenAssistantTeam();
  const { assistantsCollapsed, toggleAssistants } = useHomeSectionPreferences();
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const nowMs = useNowMinuteMs();
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const sidebar = props.sidebar === true;
  if (active.length === 0 && teams.length === 0) return null;
  const environmentId = active[0]?.environmentId ?? teams[0]!.environmentId;
  const toggleFold = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const keyByThread = new Map(
    active.flatMap((entry) => {
      const ref = threadRefOf(entry);
      return ref === null ? [] : [[scopedThreadKey(ref), assistantEntryKey(entry)] as const];
    }),
  );
  const needsKeys = new Set<string>();
  for (const shell of shells) {
    const key = keyByThread.get(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)));
    if (key !== undefined && assistantPresence(shell).mood === "needs") needsKeys.add(key);
  }
  const sections = assistantSections({ assistants: active, teams, needsKeys });
  const projectName = (envId: string, projectId: string) =>
    projects.find((project) => project.environmentId === envId && project.id === projectId)
      ?.title ?? "Project";
  const projectLabelOf = (entry: AssistantEntry) =>
    entry.assistant.scope === "project"
      ? projectName(entry.environmentId, entry.assistant.projectId)
      : null;
  const environmentCount = new Set(active.map((entry) => entry.environmentId)).size;
  const row = (
    entry: AssistantEntry,
    extra: { nested?: boolean; projectLabel?: string | null },
  ) => (
    <AssistantRow
      key={assistantEntryKey(entry)}
      entry={entry}
      sidebar={sidebar}
      nowMs={nowMs}
      environmentLabel={
        environmentCount > 1 ? (props.environmentLabelById.get(entry.environmentId) ?? null) : null
      }
      {...extra}
    />
  );
  const mutedIcon = sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle";
  const shown = active.slice(0, COLLAPSED_AVATAR_LIMIT);
  const hidden = active.length - shown.length;
  const addActions: MenuAction[] = [
    { id: "assistant", title: "New assistant", image: "person.badge.plus" },
    { id: "group", title: "New group", image: "person.2" },
    { id: "describe", title: "Describe one and let T3 build it", image: "sparkles" },
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
              {shown.map((entry) => (
                <AssistantAvatarButton key={assistantEntryKey(entry)} entry={entry} />
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
          {sections.needs.length > 0 ? (
            <>
              <SectionLabel tone="text-warning-foreground">{`Needs you · ${sections.needs.length}`}</SectionLabel>
              {sections.needs.map((entry) => row(entry, { projectLabel: projectLabelOf(entry) }))}
            </>
          ) : null}
          {sections.groups.length > 0 ? (
            <>
              <SectionLabel
                tone={sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary"}
              >
                Groups
              </SectionLabel>
              {sections.groups.map(({ team, members }) => {
                const key = `group:${team.environmentId}:${team.team.id}`;
                return (
                  <View key={key}>
                    <GroupFoldRow
                      entry={team}
                      members={members}
                      folded={folded.has(key)}
                      sidebar={sidebar}
                      onToggle={() => toggleFold(key)}
                    />
                    {folded.has(key) ? null : members.length === 0 ? (
                      <Text className="ml-3.5 border-l border-border py-1 pl-3 text-xs text-foreground-muted">
                        No members yet
                      </Text>
                    ) : (
                      members.map((entry) =>
                        row(entry, { nested: true, projectLabel: projectLabelOf(entry) }),
                      )
                    )}
                  </View>
                );
              })}
            </>
          ) : null}
          {sections.projects.length > 0 ? (
            <>
              <SectionLabel
                tone={sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary"}
              >
                Projects
              </SectionLabel>
              {sections.projects.map((project) => {
                const key = `project:${project.environmentId}:${project.projectId}`;
                const name = projectName(project.environmentId, project.projectId);
                return (
                  <View key={key}>
                    <FoldRow
                      label={name}
                      folded={folded.has(key)}
                      sidebar={sidebar}
                      onToggle={() => toggleFold(key)}
                      leading={
                        <SymbolView
                          name="folder"
                          size={16}
                          tintColorClassName={mutedIcon}
                          type="monochrome"
                        />
                      }
                      menuLabel={`${name} actions`}
                      actions={[
                        { id: "new", title: "New assistant in this project", image: "plus" },
                      ]}
                      onAction={() =>
                        openEditor(EnvironmentId.make(project.environmentId), null, {
                          projectId: ProjectId.make(project.projectId),
                        })
                      }
                    />
                    {folded.has(key)
                      ? null
                      : project.members.map((entry) => row(entry, { nested: true }))}
                  </View>
                );
              })}
            </>
          ) : null}
          {sections.unassigned.length > 0 ? (
            <>
              {sections.needs.length + sections.groups.length + sections.projects.length > 0 ? (
                <SectionLabel
                  tone={sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary"}
                >
                  Unassigned
                </SectionLabel>
              ) : null}
              {sections.unassigned.map((entry) => row(entry, {}))}
            </>
          ) : null}
        </>
      )}
    </View>
  );
}
