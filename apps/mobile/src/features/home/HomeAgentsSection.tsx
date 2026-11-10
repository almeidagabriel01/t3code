import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  selectAgentsSection,
  type AgentsSectionEntry,
} from "@t3tools/client-runtime/state/thread-activity";
import { Pressable, View } from "react-native";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useProjects } from "../../state/entities";
import { SubagentStatusDot } from "../threads/SubagentStatusDot";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { buildHomeActivityEntries } from "./homeActivityEntries";
import { SymbolView } from "../../components/ui/AppSymbol";
import { UnreadActionsMenu } from "./UnreadActionsMenu";
import { useHomeSectionPreferences } from "./useHomeSectionPreferences";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

function elapsedLabel(startedAt: string | null, nowMs: number): string {
  const startedMs = startedAt === null ? NaN : Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return "";
  const minutes = Math.max(0, Math.floor((nowMs - startedMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * Agents working or finished unseen, from every project, ranked as web's Activity page ranks
 * them. It sits outside any navigator in the tablet sidebar, so rows open by id.
 */
export function HomeAgentsSection(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly gutter: number;
  readonly sidebar?: boolean;
}) {
  const openDecisionThreadKeys = useOpenDecisionThreadKeys();
  const projects = useProjects();
  const nowMs = useNowMinuteMs();
  const selectDetail = useSelectWorkspaceDetail();
  const { agentsDoneExpanded, toggleAgentsDone } = useHomeSectionPreferences();
  const { working, done } = selectAgentsSection(
    buildHomeActivityEntries({ threads: props.threads, now: props.now, openDecisionThreadKeys }),
  );
  if (working.length + done.length === 0) return null;
  const sidebar = props.sidebar === true;
  const muted = sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary";
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const groups = [
    { heading: "Working", items: working },
    { heading: "Done", items: done },
  ].filter((group) => group.items.length > 0);
  const renderRow = (entry: AgentsSectionEntry) => {
    const { thread } = entry;
    const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
    const isWorking = entry.rank === 1;
    return (
      <Pressable
        key={entry.key}
        accessibilityRole="button"
        accessibilityLabel={`${thread.title}, ${project?.title ?? "Unknown project"}, ${isWorking ? "working" : "finished"}`}
        onPress={() => {
          const ref = scopeThreadRef(thread.environmentId, thread.id);
          selectDetail({
            name: "Thread",
            params: { environmentId: String(ref.environmentId), threadId: String(ref.threadId) },
          });
        }}
        className="min-h-12 flex-row items-center gap-3 rounded-2xl px-2 active:opacity-70"
      >
        {project ? (
          <ProjectFavicon
            environmentId={thread.environmentId}
            faviconPath={project.faviconPath}
            projectIcon={project.projectIcon}
            size={20}
            projectTitle={project.title}
            workspaceRoot={project.workspaceRoot}
          />
        ) : null}
        <Text
          className={cn(
            "min-w-0 flex-1 text-base font-t3-medium",
            sidebar ? "text-drawer-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {thread.title}
        </Text>
        {isWorking ? (
          <View className="flex-row items-center gap-1.5">
            <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
            <Text className={cn("text-xs", muted)}>{elapsedLabel(entry.at, nowMs)}</Text>
          </View>
        ) : (
          <SubagentStatusDot tone="completed" placement="sheet" />
        )}
      </Pressable>
    );
  };
  return (
    <View className="gap-1 pb-3 pt-2" style={{ paddingHorizontal: props.gutter }}>
      <Text className={cn("font-t3-bold text-2xs uppercase tracking-[1.1px]", muted)}>Agents</Text>
      {groups.map((group) => (
        <View key={group.heading}>
          <View className="min-h-9 flex-row items-center">
            {group.heading === "Done" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Done, ${group.items.length}`}
                accessibilityState={{ expanded: agentsDoneExpanded }}
                hitSlop={8}
                onPress={toggleAgentsDone}
                className="min-h-9 flex-1 flex-row items-center gap-1 px-2 active:opacity-70"
              >
                <Text className={cn("text-xs font-t3-medium", muted)}>
                  {group.heading} · {group.items.length}
                </Text>
                <SymbolView
                  name={agentsDoneExpanded ? "chevron.down" : "chevron.right"}
                  size={11}
                  tintColorClassName={
                    sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle"
                  }
                  type="monochrome"
                />
              </Pressable>
            ) : (
              <Text className={cn("flex-1 px-2 pb-1 pt-2 text-xs font-t3-medium", muted)}>
                {group.heading} · {group.items.length}
              </Text>
            )}
            {group.heading === "Done" ? (
              <UnreadActionsMenu
                threads={group.items.map((entry) => entry.thread)}
                now={props.now}
                sidebar={sidebar}
              />
            ) : null}
          </View>
          {group.heading === "Done" && !agentsDoneExpanded ? null : group.items.map(renderRow)}
        </View>
      ))}
    </View>
  );
}
