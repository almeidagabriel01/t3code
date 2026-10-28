import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { hideIdleFolderProjects } from "@t3tools/client-runtime/state/projects";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { useComposerDraftStore } from "../composerDraftStore";
import { serverEnvironment } from "../state/server";
import { orderItemsByPreferredIds, sortSidebarV2ProjectGroups } from "../components/Sidebar.logic";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "../state/entities";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

/** `environmentId:projectId` of every project opened with Open folder. */
export const folderProjectKeysAtom = Atom.make(
  (get) =>
    new Set(
      [...get(environmentCatalog.catalogValueAtom).entries.keys()].flatMap((environmentId) =>
        Object.keys(
          get(serverEnvironment.settingsValueAtom(environmentId))?.folderProjects ?? {},
        ).map((projectId) => `${environmentId}:${projectId}`),
      ),
    ),
).pipe(Atom.withLabel("web-folder-project-keys"));

export function useSidebarProjectGroups() {
  const folderKeys = useAtomValue(folderProjectKeysAtom);
  const routeDraftKey = useLocation({
    select: (location) => location.pathname.match(/^\/draft\/([^/]+)/)?.[1] ?? null,
  });
  // An empty draft left behind does not keep a folder listed; the open one or a typed one does.
  const draftProjectKeys = useComposerDraftStore((store) =>
    Object.entries(store.draftThreadsByThreadKey)
      .filter(
        ([key]) =>
          key === routeDraftKey || (store.draftsByThreadKey[key]?.prompt.trim() ?? "") !== "",
      )
      .map(([, draft]) => `${draft.environmentId}:${draft.projectId}`)
      .join("\n"),
  );
  // Activity order lags a running thread's streaming ticks until its next
  // real change; reading every tick re-rendered the whole sidebar with it.
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const projects = hideIdleFolderProjects(
    useProjects(),
    folderKeys,
    new Set([
      ...threads.map((thread) => `${thread.environmentId}:${thread.projectId}`),
      ...draftProjectKeys.split("\n"),
    ]),
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const unsortedGroups = buildSidebarProjectSnapshots({
    projects: sortOrder === "manual" ? orderedProjects : projects,
    groupScratchProjects: true,
    settings: groupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
  });
  return sortSidebarV2ProjectGroups(unsortedGroups, threads, sortOrder, delegatedUnderParent);
}
