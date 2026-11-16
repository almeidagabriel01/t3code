import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { assistantGroupFoldKey, visibleAssistants } from "@t3tools/client-runtime/assistantList";
import { assistantFace, type AssistantFace } from "@t3tools/client-runtime/assistantRobot";
import { assistantSectionThreadKeys } from "@t3tools/client-runtime/assistantTasks";
import type { ZoneIndicator } from "@t3tools/client-runtime/sidebarZones";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { memo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { RowMenuButton } from "../../components/ui/RowMenuButton";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { useQuietThreadShells } from "../../state/entities";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import {
  useAssistantLiveWork,
  useAssistantTasksByAssistant,
  type AssistantEntry,
  type AssistantTeamEntry,
} from "../../state/assistants";
import { ThreadListV2SubagentRow } from "../threads/thread-list-v2-items";
import type { ThreadListV2ThreadListItem } from "../threads/threadListV2";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import { useThreadListActions } from "../home/useThreadListActions";
import { useSidebarZones, type TeamsMember } from "../home/useSidebarZones";
import { AssistantAvatar } from "./assistantPresentation";
import {
  AssistantTaskRows,
  assistantShelfKey,
  assistantTaskSectionsOf,
  useAssistantSectionOpen,
} from "./AssistantTaskRows";
import { useAssistantFlows, useAssistantTeamFlows } from "./useAssistantFlows";
import { useOpenAssistantEditor } from "./openAssistantEditor";
import { useOpenAssistantInfo } from "./openAssistantInfo";
import { useOpenAssistantWork } from "./assistantWorkTarget";
import { useOpenAssistantTeam } from "./assistantTeamTarget";
import { useHomeSectionPreferences } from "../home/useHomeSectionPreferences";

const entryKey = ({ environmentId, assistant }: AssistantEntry) =>
  `${environmentId}:${assistant.id}`;
const shellKey = (shell: EnvironmentThreadShell) => `${shell.environmentId}:${shell.id}`;
const NO_SUBAGENTS: ReadonlyArray<EnvironmentThreadShell> = [];

/**
 * What the Teams zone draws, from one place: the zone renders it and ⌘1–9 numbers it, so the
 * numbers follow every fold, shelf and Show all the user sees. Each assistant appears once.
 */
function useAssistantSectionModel() {
  const zones = useSidebarZones();
  const preferences = useHomeSectionPreferences();
  const shells = useQuietThreadShells();
  const work = useAssistantLiveWork();
  const tasksByAssistant = useAssistantTasksByAssistant();
  const { threadOrder } = useThreadListV2ShelfPreferences();
  const nowMs = useNowMinuteMs();
  const { open } = useAssistantSectionOpen();
  const { ungrouped } = zones.layout;
  const { shown: listed, hidden: hiddenInList } = visibleAssistants(
    ungrouped,
    preferences.assistantsShowAll,
  );
  const expandedGroups = new Set(preferences.assistantsExpandedGroups);
  const folders = zones.layout.folders.map(({ team, members }) => {
    const foldKey = assistantGroupFoldKey(team.environmentId, team.team.id);
    return {
      team,
      members,
      foldKey,
      expanded: members.length > 0 && expandedGroups.has(foldKey),
      indicator: zones.indicators.folder.get(`${team.environmentId}:${team.team.id}`) ?? null,
    };
  });
  const shellByKey = new Map(shells.map((shell) => [shellKey(shell), shell]));
  const rowOf = (entry: AssistantEntry) => {
    const key = entryKey(entry);
    const live = work.subagents.get(key) ?? NO_SUBAGENTS;
    return {
      sections: assistantTaskSectionsOf(
        tasksByAssistant.get(key) ?? [],
        (threadId) => shellByKey.get(`${entry.environmentId}:${threadId}`),
        threadOrder,
        nowMs,
      ),
      subagents: [
        ...sortPinnedThreadsByOrderKey(live.filter((child) => child.pinnedAt != null)),
        ...live.filter((child) => child.pinnedAt == null),
      ],
      folded: preferences.assistantsFolded.has(key),
    };
  };
  // Render order: the ungrouped list, then each open folder's members.
  const drawn = preferences.assistantsCollapsed
    ? []
    : [...listed, ...folders.flatMap((folder) => (folder.expanded ? folder.members : []))].map(
        (item) => item.entry,
      );
  return {
    zones,
    listed,
    hiddenInList,
    ungrouped,
    folders,
    preferences,
    shellByKey,
    open,
    rowOf,
    drawn,
  };
}

type AssistantRowModel = ReturnType<ReturnType<typeof useAssistantSectionModel>["rowOf"]>;

/** The section's thread rows in drawn order, for ⌘1–9; none while it is not drawn. */
export function useAssistantSectionJumpThreads(
  drawn: boolean,
): ReadonlyArray<EnvironmentThreadShell> {
  const model = useAssistantSectionModel();
  if (!drawn) return [];
  const keys = assistantSectionThreadKeys(
    model.drawn.map((entry) => {
      const row = model.rowOf(entry);
      return {
        chatKey:
          entry.assistant.threadId === null
            ? null
            : `${entry.environmentId}:${entry.assistant.threadId}`,
        folded: row.folded,
        sections: row.sections,
        snoozedOpen: model.open.has(assistantShelfKey("snoozed", entry)),
        settledOpen: model.open.has(assistantShelfKey("settled", entry)),
        subagentKeys: row.subagents.map(shellKey),
      };
    }),
  );
  return [...new Set(keys)].flatMap((key) => model.shellByKey.get(key) ?? []);
}

const INDICATOR_DOT = {
  needs: "bg-warning",
  failed: "bg-adaptive-rose-600-400",
  limited: "bg-warning",
  paused: "bg-foreground-muted",
  running: "bg-adaptive-sky-600-400",
} as const;

function indicatorLabel(indicator: ZoneIndicator, assistant: boolean): string {
  switch (indicator.kind) {
    case "needs":
      return indicator.count === 1 ? "Needs you" : `${indicator.count} need you`;
    case "failed":
      return "Failed";
    case "limited":
      return "Usage limit";
    case "paused":
      return `${indicator.count} paused`;
    case "running":
      return assistant ? "Working" : `${indicator.count} running`;
    case "unread":
      return `${indicator.count} unread`;
  }
}

/** One static status mark: a dot with a short word, or the unread count. Nothing animates. */
function IndicatorBadge(props: {
  readonly kind: ZoneIndicator["kind"];
  readonly count: number;
  readonly assistant: boolean;
  readonly sidebar: boolean;
}) {
  const indicator = { kind: props.kind, count: props.count } as ZoneIndicator;
  if (props.kind === "unread") {
    return (
      <View
        testID="zone-indicator"
        accessibilityLabel={indicatorLabel(indicator, props.assistant)}
        className="min-w-5 items-center rounded-full bg-primary px-1.5 py-px"
      >
        <Text className="text-2xs font-t3-bold text-primary-foreground">
          {props.count > 99 ? "99+" : props.count}
        </Text>
      </View>
    );
  }
  return (
    <View testID="zone-indicator" className="shrink-0 flex-row items-center gap-1">
      <View className={cn("size-2 rounded-full", INDICATOR_DOT[props.kind])} />
      <Text
        className={cn(
          "text-xs",
          props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {indicatorLabel(indicator, props.assistant)}
      </Text>
    </View>
  );
}

/** The row's role text gives way below this width (14rem), so the name stays whole. */
const ROLE_MIN_ROW_WIDTH = 224;
/** Below this the role would show as a couple of letters; the tooltip-less row drops it instead. */
const META_MIN_WIDTH = 56;

/**
 * The assistant's own line. It reads no shared lists: every value arrives as a plain prop, so a
 * busy thread elsewhere never redraws it.
 */
const AssistantRow = memo(function AssistantRow(props: {
  // Not the entry: the assistant list wraps every assistant anew on each change, while the
  // assistant itself keeps its identity until it changes.
  readonly environmentId: AssistantEntry["environmentId"];
  readonly assistant: AssistantEntry["assistant"];
  readonly face: AssistantFace;
  readonly indicatorKind: ZoneIndicator["kind"] | null;
  readonly indicatorCount: number;
  readonly working: boolean;
  readonly foldable: boolean;
  readonly expanded: boolean;
  readonly environmentLabel: string | null;
  readonly sidebar: boolean;
  readonly nested: boolean;
  readonly onToggleFold: (key: string) => void;
}) {
  const { assistant, environmentId } = props;
  const flows = useAssistantFlows(environmentId);
  const openEditor = useOpenAssistantEditor();
  const openWork = useOpenAssistantWork();
  const openInfo = useOpenAssistantInfo();
  const [rowWidth, setRowWidth] = useState(Number.POSITIVE_INFINITY);
  const [metaWidth, setMetaWidth] = useState(Number.POSITIVE_INFINITY);
  const meta = [rowWidth >= ROLE_MIN_ROW_WIDTH ? assistant.role : "", props.environmentLabel ?? ""]
    .filter((part) => part !== "")
    .join(" · ");
  const muted = props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const status =
    props.indicatorKind === null
      ? null
      : indicatorLabel(
          { kind: props.indicatorKind, count: props.indicatorCount } as ZoneIndicator,
          true,
        );
  const actions: MenuAction[] = [
    { id: "info", title: "Assistant info", image: "info.circle" },
    {
      id: "reset",
      title: "Reset conversation",
      image: "arrow.clockwise",
      attributes: { disabled: !flows.canAct || props.working },
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
  const onAction = (id: string) => {
    if (id === "info") openInfo.assistant(environmentId, assistant.id);
    else if (id === "reset") flows.reset(assistant, { openAfter: true });
    else if (id === "work") openWork(environmentId, assistant.id);
    else if (id === "settings") openEditor(environmentId, assistant);
    else if (id === "archive") flows.archive(assistant);
  };
  return (
    <View
      className={cn("flex-row items-center", props.nested && "ml-3.5 border-l border-border pl-1")}
    >
      {/* The menu ignores layout classes, so the row's flex sits on this view. */}
      <View className="min-w-0 flex-1">
        <Menu
          actions={actions}
          onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
          shouldOpenOnLongPress
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[assistant.name, assistant.role || null, status]
              .filter(Boolean)
              .join(", ")}
            disabled={assistant.threadId === null}
            onPress={() => flows.openConversation(assistant)}
            onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
            className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-2xl px-2 active:opacity-70"
          >
            <AssistantAvatar
              assistant={assistant}
              environmentId={environmentId}
              mood={props.face}
              size={24}
            />
            <Text
              className={cn(
                "shrink text-base font-t3-medium",
                props.sidebar ? "text-drawer-foreground" : "text-foreground",
              )}
              numberOfLines={1}
            >
              {assistant.name}
            </Text>
            {/* Grows into the space left, so it truncates before the name does; one string, so a
                tight row cuts its end instead of leaving a fragment of each part. */}
            <View
              className="min-w-0 flex-1"
              onLayout={(event) => setMetaWidth(event.nativeEvent.layout.width)}
            >
              {meta !== "" && metaWidth >= META_MIN_WIDTH ? (
                <Text className={cn("text-sm", muted)} numberOfLines={1}>
                  {meta}
                </Text>
              ) : null}
            </View>
            {props.indicatorKind === null ? null : (
              <IndicatorBadge
                kind={props.indicatorKind}
                count={props.indicatorCount}
                assistant
                sidebar={props.sidebar}
              />
            )}
          </Pressable>
        </Menu>
      </View>
      {props.foldable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.expanded ? "Hide" : "Show"} ${assistant.name} tasks`}
          accessibilityState={{ expanded: props.expanded }}
          hitSlop={6}
          onPress={() => props.onToggleFold(`${environmentId}:${assistant.id}`)}
          className="size-9 items-center justify-center rounded-full active:opacity-70"
        >
          <SymbolView
            name={props.expanded ? "chevron.down" : "chevron.right"}
            size={11}
            tintColorClassName={
              props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"
            }
            type="monochrome"
          />
        </Pressable>
      ) : null}
      <RowMenuButton
        label={`${assistant.name} actions`}
        sidebar={props.sidebar}
        actions={actions}
        onAction={onAction}
      />
    </View>
  );
});

/** An assistant's row, then its tasks and live subagents while unfolded. */
function AssistantBlock(props: {
  readonly member: TeamsMember;
  readonly row: AssistantRowModel;
  readonly environmentLabel: string | null;
  readonly sidebar: boolean;
  readonly nested: boolean;
  readonly onToggleFold: (key: string) => void;
  readonly renderThread?: ((item: ThreadListV2ThreadListItem) => ReactNode) | undefined;
  readonly onSetSubagentPinned: (thread: EnvironmentThreadShell, pinned: boolean) => void;
  readonly pinningEnvironmentIds: ReadonlySet<string>;
}) {
  const { entry, presence, indicator } = props.member;
  const flows = useAssistantFlows(entry.environmentId);
  const { sections, subagents } = props.row;
  const expanded = !props.row.folded;
  const foldable =
    sections.pinned.length +
      sections.open.length +
      sections.snoozed.length +
      sections.settled.length +
      subagents.length >
    0;
  return (
    <View>
      <AssistantRow
        environmentId={entry.environmentId}
        assistant={entry.assistant}
        face={assistantFace(presence)}
        indicatorKind={indicator?.kind ?? null}
        indicatorCount={indicator !== null && "count" in indicator ? indicator.count : 0}
        working={presence.mood === "working"}
        foldable={foldable}
        expanded={expanded}
        environmentLabel={props.environmentLabel}
        sidebar={props.sidebar}
        nested={props.nested}
        onToggleFold={props.onToggleFold}
      />
      {expanded ? (
        <>
          <AssistantTaskRows
            entry={entry}
            sections={sections}
            sidebar={props.sidebar}
            {...(props.renderThread ? { renderThread: props.renderThread } : {})}
          />
          {subagents.map((child) => (
            <ThreadListV2SubagentRow
              key={child.id}
              pane={props.sidebar ? "sidebar" : "screen"}
              thread={child}
              onSelectThread={(thread) => flows.openConversation({ threadId: thread.id })}
              menu={{
                pinningSupported: props.pinningEnvironmentIds.has(child.environmentId),
                onSetPinned: props.onSetSubagentPinned,
              }}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

/** A group folder: the chevron shows its members, the name opens its chat. No faces. */
const FolderRow = memo(function FolderRow(props: {
  readonly environmentId: AssistantTeamEntry["environmentId"];
  readonly team: AssistantTeamEntry["team"];
  readonly memberCount: number;
  readonly expanded: boolean;
  readonly foldKey: string;
  readonly indicatorKind: ZoneIndicator["kind"] | null;
  readonly indicatorCount: number;
  readonly sidebar: boolean;
  readonly onToggle: (foldKey: string) => void;
}) {
  const openTeam = useOpenAssistantTeam();
  const openEditor = useOpenAssistantEditor();
  const openInfo = useOpenAssistantInfo();
  const flows = useAssistantTeamFlows(props.environmentId);
  const { environmentId, team } = props;
  const unread = team.chat?.unreadCount ?? 0;
  const mutedIcon = props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle";
  const muted = props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const empty = props.memberCount === 0;
  return (
    <View className="flex-row items-center">
      {empty ? (
        <View className="size-9" />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.expanded ? "Hide" : "Show"} ${team.name} members`}
          accessibilityState={{ expanded: props.expanded }}
          hitSlop={6}
          onPress={() => props.onToggle(props.foldKey)}
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={team.name}
        onPress={() => openTeam.chat(environmentId, team.id)}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 pr-2 active:opacity-70"
      >
        <Text
          className={cn(
            "min-w-0 flex-1 text-base font-t3-medium",
            props.sidebar ? "text-drawer-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {team.name}
        </Text>
        {props.indicatorKind !== null ? (
          <IndicatorBadge
            kind={props.indicatorKind}
            count={props.indicatorCount}
            assistant={false}
            sidebar={props.sidebar}
          />
        ) : empty ? (
          <Text testID="group-status" className={cn("text-xs", muted)}>
            empty
          </Text>
        ) : null}
      </Pressable>
      <RowMenuButton
        label={`${team.name} actions`}
        sidebar={props.sidebar}
        actions={[
          { id: "chat", title: "Open chat", image: "bubble.left.and.bubble.right" },
          { id: "info", title: "Group info", image: "info.circle" },
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
          else if (id === "info") openInfo.group(environmentId, team.id);
          else if (id === "read") void flows.markRead(team);
          else if (id === "unread") void flows.markUnread(team);
          else if (id === "edit") openTeam.edit(environmentId, team.id);
          else if (id === "new") openEditor(environmentId, null, { teamId: team.id });
          else if (id === "archive") flows.archive(team);
        }}
      />
    </View>
  );
});

/** The Teams zone: ungrouped assistants first, then one folder per group. */
export function HomeAssistantsSection(props: {
  readonly gutter: number;
  readonly sidebar?: boolean;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  /** The host list's thread row, so task rows get its menu, swipes and selection. */
  readonly renderThread?: (item: ThreadListV2ThreadListItem) => ReactNode;
}) {
  const model = useAssistantSectionModel();
  const { listed, hiddenInList, ungrouped, folders } = model;
  const navigation = useNavigation();
  const openEditor = useOpenAssistantEditor();
  const openTeam = useOpenAssistantTeam();
  const { pinThread, unpinThread } = useThreadListActions();
  const { pinningEnvironmentIds } = useAtomValue(threadListEnvironmentsAtom);
  const {
    assistantsCollapsed,
    toggleAssistants,
    assistantsShowAll,
    toggleAssistantsShowAll,
    toggleAssistantFolded,
    toggleAssistantsGroup,
  } = model.preferences;
  const sidebar = props.sidebar === true;
  const assistantCount =
    ungrouped.length + folders.reduce((sum, folder) => sum + folder.members.length, 0);
  if (assistantCount === 0 && folders.length === 0) return null;
  const environmentId = ungrouped[0]?.entry.environmentId ?? folders[0]!.team.environmentId;
  const setSubagentPinned = (thread: EnvironmentThreadShell, pinned: boolean) =>
    void (pinned ? pinThread(thread) : unpinThread(thread));
  const foldable = assistantsShowAll || hiddenInList > 0;
  const environmentCount = new Set([
    ...ungrouped.map((item) => item.entry.environmentId),
    ...folders.flatMap((folder) => folder.members.map((item) => item.entry.environmentId)),
  ]).size;
  const block = (member: TeamsMember, nested: boolean) => (
    <AssistantBlock
      key={member.key}
      member={member}
      row={model.rowOf(member.entry)}
      environmentLabel={
        environmentCount > 1
          ? (props.environmentLabelById.get(member.entry.environmentId) ?? null)
          : null
      }
      sidebar={sidebar}
      nested={nested}
      onToggleFold={toggleAssistantFolded}
      renderThread={props.renderThread}
      onSetSubagentPinned={setSubagentPinned}
      pinningEnvironmentIds={pinningEnvironmentIds}
    />
  );
  const mutedIcon = sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle";
  const mutedText = sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary";
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
          accessibilityLabel="Teams"
          accessibilityState={{ expanded: !assistantsCollapsed }}
          hitSlop={8}
          onPress={toggleAssistants}
          className="min-h-9 flex-row items-center gap-1 active:opacity-70"
        >
          <Text className={cn("font-t3-bold text-2xs uppercase tracking-[1.1px]", mutedText)}>
            Teams
          </Text>
          {assistantsCollapsed ? (
            <Text testID="teams-count" className={cn("font-t3-bold text-2xs", mutedText)}>
              {assistantCount}
            </Text>
          ) : null}
          <SymbolView
            name={assistantsCollapsed ? "chevron.right" : "chevron.down"}
            size={11}
            tintColorClassName={mutedIcon}
            type="monochrome"
          />
        </Pressable>
        <View className="flex-1" />
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
          {listed.map((member) => block(member, false))}
          {foldable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={assistantsShowAll ? "Show less" : "Show all"}
              onPress={toggleAssistantsShowAll}
              className="min-h-10 justify-center px-2 active:opacity-70"
            >
              <Text className={cn("text-xs font-t3-medium", mutedText)}>
                {assistantsShowAll ? "Show less" : `Show all (${ungrouped.length})`}
              </Text>
            </Pressable>
          ) : null}
          {folders.map((folder) => (
            <View key={folder.foldKey}>
              <FolderRow
                environmentId={folder.team.environmentId}
                team={folder.team.team}
                memberCount={folder.members.length}
                expanded={folder.expanded}
                foldKey={folder.foldKey}
                indicatorKind={folder.indicator?.kind ?? null}
                indicatorCount={
                  folder.indicator !== null && "count" in folder.indicator
                    ? folder.indicator.count
                    : 0
                }
                sidebar={sidebar}
                onToggle={toggleAssistantsGroup}
              />
              {folder.expanded ? folder.members.map((member) => block(member, true)) : null}
            </View>
          ))}
        </>
      )}
    </View>
  );
}
