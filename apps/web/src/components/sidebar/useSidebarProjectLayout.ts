import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { getProjectOrderKey } from "../../logicalProject";
import { useProjects } from "../../state/entities";
import { orderItemsByPreferredIds } from "../Sidebar.logic";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  legacyProjectCwdPreferenceKey,
  resolveProjectExpanded,
  useUiStateStore,
} from "../../uiStateStore";
import {
  groupThreadsByProject,
  PROJECT_SETTLED_INITIAL_COUNT,
  PROJECT_SETTLED_PAGE_COUNT,
  resolveVisibleProjectThreads,
} from "./sidebarProjectGroups.logic";

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

function projectExpansionKeys(project: SidebarProjectSnapshot): string[] {
  return [project.projectKey, ...project.memberProjects.map((member) => member.physicalProjectKey)];
}

export function useSidebarProjectLayout(input: {
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly pinnedThreads: readonly EnvironmentThreadShell[];
  readonly unsettledThreads: readonly EnvironmentThreadShell[];
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly routeThreadKey: string | null;
}) {
  const projectExpandedById = useUiStateStore((state) => state.projectExpandedById);
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const reorderProjects = useUiStateStore((state) => state.reorderProjects);
  const projectOrder = useUiStateStore((state) => state.projectOrder);
  const projects = useProjects();
  const manualProjectOrder = useClientSettings((s) => s.sidebarProjectSortOrder) === "manual";
  const [settledByProject, setSettledByProject] = useState<
    Readonly<Record<string, { readonly expanded: boolean; readonly limit: number }>>
  >({});
  const groups = groupThreadsByProject({
    groups: input.projectGroups,
    pinned: input.pinnedThreads,
    unsettled: input.unsettledThreads,
    settled: input.settledThreads,
  });
  const projectByKey = new Map(input.projectGroups.map((project) => [project.projectKey, project]));
  const layout = groups.flatMap((group) => {
    const project = projectByKey.get(group.projectKey);
    if (project === undefined) return [];
    const expanded = resolveProjectExpanded(projectExpandedById, projectExpansionKeys(project));
    const settledState = settledByProject[group.projectKey];
    const settledExpanded = settledState?.expanded ?? false;
    const settledLimit = settledState?.limit ?? PROJECT_SETTLED_INITIAL_COUNT;
    const visible = resolveVisibleProjectThreads({
      group,
      getKey: threadKeyOf,
      expanded,
      settledExpanded,
      settledLimit,
      routeThreadKey: input.routeThreadKey,
    });
    return [
      {
        project,
        group,
        expanded,
        settledExpanded,
        settledLimit,
        visibleOpen: visible.open,
        visibleSettled: visible.settled,
        reachableSettled: visible.reachable,
        hasMoreSettled: visible.settled.length < group.settledThreads.length,
      },
    ];
  });
  return {
    layout,
    manualProjectOrder,
    reorderProject: (activeProjectKey: string, overProjectKey: string) => {
      const active = projectByKey.get(activeProjectKey);
      const over = projectByKey.get(overProjectKey);
      if (!manualProjectOrder || active === undefined || over === undefined) return;
      const ordered = orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      });
      reorderProjects(
        ordered.map(getProjectOrderKey),
        active.memberProjects.map((member) => member.physicalProjectKey),
        over.memberProjects.map((member) => member.physicalProjectKey),
      );
    },
    visibleThreads: layout.flatMap((entry) => [...entry.visibleOpen, ...entry.reachableSettled]),
    toggleProject: (project: SidebarProjectSnapshot, expanded: boolean) =>
      setProjectExpanded(projectExpansionKeys(project), !expanded),
    toggleSettled: (projectKey: string) =>
      setSettledByProject((current) => ({
        ...current,
        [projectKey]: {
          expanded: !(current[projectKey]?.expanded ?? false),
          limit: current[projectKey]?.limit ?? PROJECT_SETTLED_INITIAL_COUNT,
        },
      })),
    showMoreSettled: (projectKey: string) =>
      setSettledByProject((current) => ({
        ...current,
        [projectKey]: {
          expanded: true,
          limit:
            (current[projectKey]?.limit ?? PROJECT_SETTLED_INITIAL_COUNT) +
            PROJECT_SETTLED_PAGE_COUNT,
        },
      })),
  };
}
