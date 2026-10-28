import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import { newMessageId, newThreadId } from "../../lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The environment whose host holds the fork checkout: the local primary one, when it grants git inspection. */
export function useForkUpdatesEnvironmentId(): EnvironmentId | null {
  const environmentId = usePrimaryEnvironmentId();
  const granted = useEnvironmentsWithScope(
    environmentId === null ? [] : [{ environmentId }],
    AuthDiagnosticsReadScope,
  );
  return environmentId !== null && granted.has(environmentId) ? environmentId : null;
}

/** Refreshes on its own every 6 hours while mounted. Mounting runs `git fetch` on the server. */
export function useForkUpdateStatus(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const path = useClientSettings((settings) => settings.forkUpdatesFolder);
  const channel = useClientSettings((settings) => settings.forkUpdatesChannel);
  const atom = serverEnvironment.forkUpdateStatus({ environmentId, input: { path, channel } });
  const result = useAtomValue(atom);
  return {
    status: Option.getOrNull(AsyncResult.value(result)),
    checking: result.waiting,
    check: () => registry.refresh(atom),
  };
}

const MERGE_PROMPT = (path: string, channel: string, tag: string) =>
  `In ${path}, merge the upstream ${channel} release ${tag} into main and keep this fork working.

1. \`git fetch upstream --tags\`, then \`git merge ${tag}\` (merge, never rebase: main is published; never merge upstream/main).
2. Resolve every conflict preserving this fork's features (kanban, status bar and provider budgets, the fork DB schema in apps/server/src/persistence/ForkSchema.ts, fork updates). Prefer upstream for everything else.
3. Run \`vp run check:changed\` and fix what fails.
4. Commit the merge.
5. Run \`vp run fork:update --channel ${channel} --push --install --rebuild\`. It builds the app, pushes main and replaces the installed app, so the app quits and reopens at the end. Report the result first if you can.`;

const UPDATE_PROMPT = (path: string, channel: string) =>
  `In ${path}, run \`vp run fork:update --channel ${channel} --push --install\`. The build takes several minutes, so run it in the background and watch its output. If it exits with code 2 the merge conflicted and was aborted: say so and stop. Otherwise report the result; the app quits and reopens when the install finishes.`;

export type ForkAgentTask = "update" | "resolve";

/** Starts a thread in the project whose workspace root is the fork folder. Null when no such project exists. */
export function useStartForkAgent(environmentId: EnvironmentId, status: ForkUpdateStatus | null) {
  const path = status?.available ? status.path : null;
  const navigate = useNavigate();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    label: "fork update agent",
  });
  const projects = useProjects();
  const project =
    path === null
      ? null
      : (projects.find(
          (candidate) =>
            candidate.environmentId === environmentId && candidate.workspaceRoot === path,
        ) ?? null);
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;

  if (project === null || status === null) return null;
  return async (task: ForkAgentTask) => {
    const entries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, project.id),
    );
    const selection = scheduledTaskDefaultModel(settings, project, entries);
    if (selection === null) {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "No provider is ready to start the agent" }),
      );
      return;
    }
    const runtimeMode = resolveProjectSettings(settings, project.id, project).settings
      .defaultRuntimeMode;
    const title = task === "update" ? "Update fork" : "Resolve fork merge conflicts";
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text:
            task === "update"
              ? UPDATE_PROMPT(project.workspaceRoot, status.channel)
              : MERGE_PROMPT(
                  project.workspaceRoot,
                  status.channel,
                  status.upstreamTag ?? "the latest tag",
                ),
          attachments: [],
        },
        modelSelection: selection,
        titleSeed: title,
        runtimeMode,
        interactionMode: DEFAULT_INTERACTION_MODE,
        createdAt,
        bootstrap: {
          createThread: {
            projectId: project.id,
            title,
            modelSelection: selection,
            runtimeMode,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
          },
        },
      },
    });
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start the agent",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: scopeThreadRef(environmentId, threadId),
    });
  };
}
