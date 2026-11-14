import {
  type AssistantId,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SettingsTarget } from "./settings-environment-filter";
import {
  managedSettingReason,
  planMobileProjectAssistantModel,
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";

const firstId = "first" as EnvironmentId;
const secondId = "second" as EnvironmentId;
const firstProject = "first-project" as ProjectId;
const secondProject = "second-project" as ProjectId;
const model = { instanceId: "codex" as never, model: "gpt-5.5" };

describe("mobile usage-limit settings across environments", () => {
  it.each(["autoResumeLimitedThreads", "snoozeLimitedThreads"] as const)(
    "shows %s as mixed and can enable it everywhere without changing other settings",
    (key) => {
      const targets = resolveMobileSettingsTargets(
        [
          environment(firstId, { ...DEFAULT_SERVER_SETTINGS, [key]: true }),
          environment(secondId, { ...DEFAULT_SERVER_SETTINGS, [key]: false }),
        ],
        null,
      );

      expect(uniformMobileSetting(targets, key)).toBeNull();
      const writes = planMobileScopedSettingsPatch(targets, false, { [key]: true });
      expect(writes).toEqual([
        { environmentId: firstId, patch: { [key]: true } },
        { environmentId: secondId, patch: { [key]: true } },
      ]);
      const updatedTargets = targets.map((target) => ({
        ...target,
        settings: {
          ...target.settings,
          [key]:
            writes.find((write) => write.environmentId === target.environment.environmentId)?.patch[
              key
            ] ?? target.settings[key],
        },
      }));
      expect(uniformMobileSetting(updatedTargets, key)).toBe(true);
      expect(uniformMobileSetting(targets.slice(0, 1), key)).toBe(true);
      expect(uniformMobileSetting(targets.slice(1), key)).toBe(false);
      expect(uniformMobileSetting([], key)).toBeNull();
    },
  );
});

function environment(environmentId: EnvironmentId, settings: ServerSettings): SettingsTarget {
  return {
    environmentId,
    serverConfig: {
      settings,
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  } as SettingsTarget;
}

describe("mobile project settings scope", () => {
  it("edits each checkout's own override without changing either environment default", () => {
    const firstSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "paragraph",
      // The assistant models stay out of the write: the server merges them per assistant, so a
      // stale copy would bring back one another client removed.
      projectSettingsOverrides: {
        [firstProject]: {
          defaultAutoPull: true,
          assistantModelSelections: { ada: model } as Record<AssistantId, typeof model>,
        },
      },
    };
    const secondSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "turn",
      projectSettingsOverrides: {},
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, firstSettings), environment(secondId, secondSettings)],
      [
        { environmentId: firstId, id: firstProject },
        { environmentId: secondId, id: secondProject },
      ],
    );

    const writes = planMobileScopedSettingsPatch(targets, true, {
      responseStreamingMode: "turn",
    });
    expect(writes).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
          },
        },
      },
      {
        environmentId: secondId,
        patch: { projectSettingsOverrides: { [secondProject]: { responseStreamingMode: "turn" } } },
      },
    ]);
    expect(firstSettings.responseStreamingMode).toBe("paragraph");
    expect(secondSettings.responseStreamingMode).toBe("turn");
  });

  it("writes one assistant's model only on its environment, and only its key", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: {
          defaultAutoPull: true,
          assistantModelSelections: { ada: model, beto: model } as Record<
            AssistantId,
            typeof model
          >,
        },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings), environment(secondId, DEFAULT_SERVER_SETTINGS)],
      [
        { environmentId: firstId, id: firstProject },
        { environmentId: secondId, id: secondProject },
      ],
    );
    const next = { ...model, model: "gpt-5.4" };
    expect(planMobileProjectAssistantModel(targets, firstId, "ada" as AssistantId, next)).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { defaultAutoPull: true, assistantModelSelections: { ada: next } },
          },
        },
      },
    ]);
    expect(
      planMobileProjectAssistantModel(targets, firstId, "beto" as AssistantId, null)[0]?.patch,
    ).toEqual({
      projectSettingsOverrides: {
        [firstProject]: { defaultAutoPull: true, assistantModelSelections: { beto: null } },
      },
    });
  });

  it("shows a folder rule's model for a project inside that folder", () => {
    const folderModel = { instanceId: "codex" as never, model: "folder-model" };
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      folderModelDefaults: [{ folder: "/work", modelSelection: folderModel }],
    };
    const [inside, outside] = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [
        { environmentId: firstId, id: firstProject, workspaceRoot: "/work/app" },
        { environmentId: firstId, id: secondProject, workspaceRoot: "/elsewhere/app" },
      ],
    );
    expect(inside?.settings.defaultModelSelection).toEqual(folderModel);
    expect(inside?.sources.defaultModelSelection).toBe("folder");
    expect(outside?.settings.defaultModelSelection).toBeNull();
  });

  it("removes a project override when a picker sends null for a key that cannot store it", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultThreadEnvMode: "worktree", defaultAutoPull: true },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(planMobileScopedSettingsPatch(targets, true, { defaultThreadEnvMode: null })).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(planMobileScopedSettingsPatch(targets, true, { defaultModelSelection: null })).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: {
              defaultThreadEnvMode: "worktree",
              defaultAutoPull: true,
              defaultModelSelection: null,
            },
          },
        },
      },
    ]);
  });

  it("resets only the selected page's override and rejects environment-wide writes", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );

    expect(planMobileScopedSettingsClear(targets, ["responseStreamingMode"])).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(
      planMobileScopedSettingsPatch(targets, true, { enableProviderUpdateChecks: false }),
    ).toEqual([]);
  });
});

describe("managed settings across environments", () => {
  it("names the manager when any selected environment locks the setting", () => {
    const managed = {
      ...environment(secondId, DEFAULT_SERVER_SETTINGS),
      serverConfig: {
        ...environment(secondId, DEFAULT_SERVER_SETTINGS).serverConfig,
        managedPolicy: { organization: "Example Corp", lockedSettings: ["storageCleanup"] },
      },
    } as SettingsTarget;
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, DEFAULT_SERVER_SETTINGS), managed],
      null,
    );

    expect(managedSettingReason(targets, "storageCleanup.logsAfterDays")).toBe(
      "Managed by Example Corp.",
    );
    expect(managedSettingReason(targets, "defaultAutoPull", "storageCleanup")).toBe(
      "Managed by Example Corp.",
    );
    expect(managedSettingReason(targets, "defaultAutoPull")).toBeUndefined();
    expect(managedSettingReason(targets.slice(0, 1), "storageCleanup")).toBeUndefined();
  });
});
