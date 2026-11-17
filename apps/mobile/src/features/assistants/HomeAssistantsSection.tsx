import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { assistantGroupFoldKey, visibleAssistants } from "@t3tools/client-runtime/assistantList";
import { teamsEnvironmentLabels } from "@t3tools/client-runtime/assistantProjectAccess";
import { assistantFace, type AssistantFace } from "@t3tools/client-runtime/assistantRobot";
import { assistantSectionThreadKeys } from "@t3tools/client-runtime/assistantTasks";
import {
  folderIndicatorDetail,
  folderIndicatorTarget,
  zoneIndicatorLabel,
  type ZoneIndicator,
} from "@t3tools/client-runtime/sidebarZones";
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
import type { SavedRemoteConnection } from "../../lib/connection";
import { useNowMinuteMs } from "../../lib/clock";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import {
  useAssistantLiveWork,
  useAssistantTasksByAssistant,
  type AssistantEntry,
  type AssistantTeamEntry,
} from "../../state/assistants";
import { ThreadListV2SubagentRow } from "../threads/thread-list-v2-items";
import { DraftMark, DRAFT_MARK_LABEL } from "../threads/draft-mark";
import { DISCARD_DRAFT_ACTION } from "../threads/thread-menu";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { assistantGroupDraftKey } from "../../state/assistant-group-draft-key";
import {
  clearComposerDraftContent,
  useComposerDraftHasContent,
} from "../../state/use-composer-drafts";
import type { ThreadListV2ThreadListItem } from "../threads/threadListV2";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import { useThreadListActions } from "../home/useThreadListActions";
import { useSidebarZones, type TeamsMember } from "../home/useSidebarZones";
import { AssistantAvatar, AssistantCluster } from "./assistantPresentation";
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
  needs: "bg-warning-foreground",
  failed: "bg-adaptive-rose-600-400",
  limited: "bg-warning-foreground",
  paused: "bg-foreground-muted",
  running: "bg-adaptive-sky-600-400",
  unread: "bg-primary",
} as const;

const indicatorLabel = (indicator: ZoneIndicator, assistant: boolean) =>
  zoneIndicatorLabel(indicator, assistant ? "assistant" : "group");

/** A group's faces with its status as a still dot in the corner; dashed when it has no members. */
function GroupMark(props: {
  readonly environmentId: AssistantTeamEntry["environmentId"];
  readonly members: ReadonlyArray<TeamsMember>;
  readonly kind: ZoneIndicator["kind"] | null;
  readonly sidebar: boolean;
}) {
  if (props.members.length === 0) {
    return (
      <View
        testID="group-status"
        className="size-5 rounded-md border border-dashed border-foreground-muted"
      />
    );
  }
  return (
    <View testID="group-mark">
      <AssistantCluster
        size={20}
        environmentId={props.environmentId}
        faces={props.members.map(({ entry }) => ({
          key: entry.assistant.id,
          assistant: entry.assistant,
        }))}
      />
      {props.kind === null ? null : (
        // A disc in the surface's own color cuts the dot out of the faces, like web's ring. A border
        // would square off the fill on iOS.
        <View
          testID="group-dot"
          className={cn(
            "absolute -right-1 -bottom-1 size-3 items-center justify-center rounded-full",
            props.sidebar ? "bg-drawer" : "bg-screen",
          )}
        >
          <View className={cn("size-2 rounded-full", INDICATOR_DOT[props.kind])} />
        </View>
      )}
    </View>
  );
}

/**
 * One static status mark: a dot with its words. An assistant's unread count, and a narrow
 * folder's, is a numbered pill; a narrow folder's other states are the dot alone. Nothing animates.
 */
function IndicatorBadge(props: {
  readonly kind: ZoneIndicator["kind"];
  readonly count: number;
  readonly assistant: boolean;
  readonly sidebar: boolean;
  readonly narrow?: boolean;
}) {
  const label = indicatorLabel(
    { kind: props.kind, count: props.count } as ZoneIndicator,
    props.assistant,
  );
  if (props.kind === "unread" && (props.assistant || props.narrow === true)) {
    return (
      <View
        testID="zone-indicator"
        accessibilityLabel={label}
        className="min-w-5 items-center rounded-full bg-primary px-1.5 py-px"
      >
        <Text className="text-2xs font-t3-bold text-primary-foreground">
          {props.count > 99 ? "99+" : props.count}
        </Text>
      </View>
    );
  }
  return (
    <View
      testID="zone-indicator"
      accessibilityLabel={label}
      className="shrink-0 flex-row items-center gap-1"
    >
      <View className={cn("size-2 rounded-full", INDICATOR_DOT[props.kind])} />
      {props.narrow === true ? null : (
        <Text
          className={cn(
            "text-xs",
            props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
    </View>
  );
}

/**
 * A group's status. A long press says where it comes from (which tab waits, works or is unread);
 * a tap on "needs you" opens the chat at the request that waits, else the chat.
 */
function FolderIndicator(props: {
  readonly environmentId: AssistantTeamEntry["environmentId"];
  readonly team: AssistantTeamEntry["team"];
  readonly kind: ZoneIndicator["kind"];
  readonly count: number;
  readonly sidebar: boolean;
  readonly narrow: boolean;
}) {
  const openTeam = useOpenAssistantTeam();
  const projects = useProjects();
  const { environmentId, team } = props;
  const label = indicatorLabel({ kind: props.kind, count: props.count } as ZoneIndicator, false);
  const detail =
    team.chat === undefined
      ? []
      : folderIndicatorDetail({
          chat: team.chat,
          projects: projects.filter((project) => project.environmentId === environmentId),
          groupProjectIds: team.projectIds,
        });
  const target = props.kind === "needs" ? folderIndicatorTarget(team.chat) : null;
  return (
    // The menu ignores layout classes, so the badge's place in the row sits on this view.
    <View className="shrink-0">
      <Menu
        title={label}
        actions={detail.map((line, index) => ({
          id: `detail-${index}`,
          title: line,
          attributes: { disabled: true },
        }))}
        shouldOpenOnLongPress
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[label, ...detail].join(". ")}
          accessibilityHint={
            target === null ? "Opens the chat" : "Opens the request that waits on you"
          }
          hitSlop={6}
          onPress={() => openTeam.chat(environmentId, team.id, target)}
          className="min-h-8 cursor-pointer justify-center rounded-full px-1 active:opacity-70"
        >
          <IndicatorBadge
            kind={props.kind}
            count={props.count}
            assistant={false}
            sidebar={props.sidebar}
            narrow={props.narrow}
          />
        </Pressable>
      </Menu>
    </View>
  );
}

/** The row's role text gives way below this width (14rem), so the name stays whole. */
const ROLE_MIN_ROW_WIDTH = 224;
/** Below this a folder's words (status, empty caption) give way, so the group's name stays readable. */
const FOLDER_WORDS_MIN_ROW_WIDTH = 320;
const EMPTY_GROUP_LABEL = "No members yet";
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
  const draftKey =
    assistant.threadId === null ? null : scopedThreadKey(environmentId, assistant.threadId);
  const hasDraft = useComposerDraftHasContent(draftKey);
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
    ...(hasDraft ? [DISCARD_DRAFT_ACTION] : []),
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
    if (id === DISCARD_DRAFT_ACTION.id && draftKey !== null) clearComposerDraftContent(draftKey);
    else if (id === "info") openInfo.assistant(environmentId, assistant.id);
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
            accessibilityLabel={[
              assistant.name,
              assistant.role || null,
              hasDraft ? DRAFT_MARK_LABEL : null,
              status,
            ]
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
            {hasDraft ? <DraftMark iconOnly={rowWidth < FOLDER_WORDS_MIN_ROW_WIDTH} /> : null}
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

/** Members arrive in a fresh array on every update; the row redraws only when one of them changes. */
function sameFolderProps<P extends { readonly members: ReadonlyArray<TeamsMember> }>(a: P, b: P) {
  return (Object.keys(a) as Array<keyof P>).every((key) =>
    key === "members"
      ? a.members.length === b.members.length &&
        a.members.every(
          (member, index) => member.entry.assistant === b.members[index]!.entry.assistant,
        )
      : a[key] === b[key],
  );
}

/** A group folder: the chevron shows its members, the name opens its chat. */
const FolderRow = memo(function FolderRow(props: {
  readonly environmentId: AssistantTeamEntry["environmentId"];
  readonly team: AssistantTeamEntry["team"];
  readonly members: ReadonlyArray<TeamsMember>;
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
  const empty = props.members.length === 0;
  const [rowWidth, setRowWidth] = useState(Number.POSITIVE_INFINITY);
  const narrow = rowWidth < FOLDER_WORDS_MIN_ROW_WIDTH;
  const draftKey = assistantGroupDraftKey(environmentId, team.id);
  const hasDraft = useComposerDraftHasContent(draftKey);
  return (
    <View
      className="flex-row items-center"
      onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
    >
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
        accessibilityLabel={[
          team.name,
          empty ? EMPTY_GROUP_LABEL : null,
          hasDraft ? DRAFT_MARK_LABEL : null,
        ]
          .filter(Boolean)
          .join(", ")}
        onPress={() => openTeam.chat(environmentId, team.id)}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 pr-2 active:opacity-70"
      >
        <GroupMark
          environmentId={environmentId}
          members={props.members}
          kind={props.indicatorKind}
          sidebar={props.sidebar}
        />
        <Text
          className={cn(
            // An empty group's caption takes only the room its name leaves.
            "min-w-0 text-base font-t3-medium",
            empty ? "shrink" : "flex-1",
            props.sidebar ? "text-drawer-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {team.name}
        </Text>
        {empty && !narrow ? (
          <Text
            testID="group-empty-caption"
            className={cn(
              "min-w-0 flex-1 text-right text-xs",
              props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {EMPTY_GROUP_LABEL}
          </Text>
        ) : null}
        {hasDraft ? <DraftMark iconOnly={narrow} /> : null}
      </Pressable>
      {props.indicatorKind !== null ? (
        <FolderIndicator
          environmentId={environmentId}
          team={team}
          kind={props.indicatorKind}
          count={props.indicatorCount}
          sidebar={props.sidebar}
          narrow={narrow}
        />
      ) : null}
      <RowMenuButton
        label={`${team.name} actions`}
        sidebar={props.sidebar}
        actions={[
          ...(hasDraft ? [DISCARD_DRAFT_ACTION] : []),
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
          if (id === DISCARD_DRAFT_ACTION.id) clearComposerDraftContent(draftKey);
          else if (id === "chat") openTeam.chat(environmentId, team.id);
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
}, sameFolderProps);

/** Teams names each environment, and falls back to its address when two share a name. */
export function teamsEnvironments(
  connections: Readonly<Record<string, SavedRemoteConnection>>,
): ReadonlyMap<string, { readonly label: string; readonly address: string }> {
  return new Map(
    Object.values(connections).map((connection) => [
      connection.environmentId,
      {
        label: connection.environmentLabel,
        address: connection.displayUrl || connection.environmentId,
      },
    ]),
  );
}

/** The Teams zone: ungrouped assistants first, then one folder per group. */
export function HomeAssistantsSection(props: {
  readonly gutter: number;
  readonly sidebar?: boolean;
  readonly environmentById: ReadonlyMap<
    string,
    { readonly label: string; readonly address: string }
  >;
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
  const environmentLabel = teamsEnvironmentLabels(
    [...ungrouped, ...folders.flatMap((folder) => folder.members)].map((item) => item.entry),
    props.environmentById,
  );
  const block = (member: TeamsMember, nested: boolean) => (
    <AssistantBlock
      key={member.key}
      member={member}
      row={model.rowOf(member.entry)}
      environmentLabel={environmentLabel(member.entry.environmentId, member.entry.assistant.id)}
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
                members={folder.members}
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
