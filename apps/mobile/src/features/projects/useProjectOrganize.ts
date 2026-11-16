import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";

import * as Dialog from "../../components/ui/Dialog";
import { openSettings } from "../settings/settings-navigation";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

type OrganizeInput = { readonly pinned?: boolean; readonly archived?: boolean };

/** Whether every checkout can be pinned or archived: operate scope, and a server that keeps both. */
export function canOrganizeMembers(input: {
  readonly members: ReadonlyArray<Pick<EnvironmentProject, "environmentId">>;
  readonly operableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly organizationByEnvironmentId: ReadonlyMap<EnvironmentId, boolean>;
}) {
  return input.members.every(
    (member) =>
      input.operableEnvironmentIds.has(member.environmentId) &&
      input.organizationByEnvironmentId.get(member.environmentId) === true,
  );
}

/** One machine at a time, stopping at the first failure, as web does. */
export function useProjectOrganize() {
  const organizeProject = useAtomCommand(projectEnvironment.update, {
    label: "project update",
    reportFailure: true,
  });
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const members = (refs: ReadonlyArray<{ environmentId: EnvironmentId; projectId: string }>) =>
    projects.filter((project) =>
      refs.some(
        (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
      ),
    );
  const operable = useEnvironmentsWithScope(projects, AuthOrchestrationOperateScope);
  const canOrganizeRefs = (
    refs: ReadonlyArray<{ environmentId: EnvironmentId; projectId: string }>,
  ) => {
    const found = members(refs);
    return (
      found.length > 0 &&
      canOrganizeMembers({
        members: found,
        operableEnvironmentIds: operable,
        organizationByEnvironmentId: new Map(
          found.map((member) => [
            member.environmentId,
            serverConfigs.get(member.environmentId)?.environment.capabilities
              .projectOrganization === true,
          ]),
        ),
      })
    );
  };
  const organize = async (
    targets: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "title">>,
    input: OrganizeInput,
  ) => {
    for (const member of targets) {
      if (!readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope)) {
        Dialog.alert("Failed to update project", "This connection can no longer change it.");
        return;
      }
      const result = await organizeProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, ...input },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Dialog.alert(
            `Failed to update "${member.title}"`,
            error instanceof Error ? error.message : "An error occurred.",
          );
        }
        return;
      }
    }
  };
  return {
    organize,
    canOrganizeRefs,
    /** Archives or unarchives the checkouts a project scope covers. */
    setScopeArchived: (
      refs: ReadonlyArray<{ environmentId: EnvironmentId; projectId: string }>,
      archived: boolean,
    ) => organize(members(refs), { archived }),
  };
}

/** Archives the selected project's checkouts, when this connection may; otherwise nothing to offer. */
/**
 * Opens Settings › Threads on the selected project. It passes one checkout's ids, so Settings
 * finds the project in its own grouping and the link survives Settings resetting its scope.
 */
export function useOpenSelectedProjectSettings(scope: {
  readonly environmentId: EnvironmentId | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly selectedKey: string | null;
}) {
  const navigation = useNavigation();
  const projects = useProjects();
  const ref = pickableProjectGroups(
    buildHomeProjectScopes({
      projects,
      environmentId: scope.environmentId,
      projectGroupingMode: scope.projectGroupingMode,
    }),
  ).find((candidate) => candidate.key === scope.selectedKey)?.projectRefs[0];
  return ref
    ? () =>
        openSettings(navigation, "SettingsThreads", {
          environmentId: ref.environmentId,
          projectId: ref.projectId,
        })
    : undefined;
}

export function useArchiveSelectedProject(scope: {
  readonly environmentId: EnvironmentId | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly selectedKey: string | null;
}) {
  const { canOrganizeRefs, setScopeArchived } = useProjectOrganize();
  const projects = useProjects();
  const refs = pickableProjectGroups(
    buildHomeProjectScopes({
      projects,
      environmentId: scope.environmentId,
      projectGroupingMode: scope.projectGroupingMode,
    }),
  ).find((candidate) => candidate.key === scope.selectedKey)?.projectRefs;
  return refs && canOrganizeRefs(refs) ? () => setScopeArchived(refs, true) : undefined;
}
