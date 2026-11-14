import {
  OrchestratorMcpFailure,
  type ProjectSettingsOverrides,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    detectProblems,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const detectProblemsInProjects: Record<string, boolean> = {};
  for (const [projectId, override] of Object.entries(settings.projectSettingsOverrides)) {
    if (override.detectProblems !== undefined)
      detectProblemsInProjects[projectId] = override.detectProblems;
  }
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    detectProblems,
    detectProblemsInProjects,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
/** The patch replaces a project's whole override set, so the others are carried over. */
const withDetectProblems = (
  overrides: ProjectSettingsOverrides,
  enabled: boolean | null,
): ProjectSettingsOverrides | null => {
  const { detectProblems: _, ...rest } = overrides;
  const next = enabled === null ? rest : { ...rest, detectProblems: enabled };
  return Object.keys(next).length === 0 ? null : next;
};

const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        const { detectProblemsInProject: scoped, ...patch } = input;
        return preferences(
          yield* (
            scoped === undefined
              ? Effect.succeed(patch)
              : settings.getSettings.pipe(
                  Effect.map((current) => ({
                    ...patch,
                    projectSettingsOverrides: {
                      [scoped.projectId]: withDetectProblems(
                        current.projectSettingsOverrides[scoped.projectId] ?? {},
                        scoped.enabled,
                      ),
                    },
                  })),
                )
          ).pipe(Effect.flatMap(settings.updateSettings), Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
