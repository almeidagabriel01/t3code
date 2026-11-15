import { ProjectId, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderInstanceOverridePatch } from "./ProviderSettingsPanel.logic";

describe("buildProviderInstanceOverridePatch", () => {
  const projectId = ProjectId.make("project-a");
  const instanceId = ProviderInstanceId.make("codex_work");

  it("writes the same choice to every checkout of the project", () => {
    const siblingId = ProjectId.make("project-a-worktree");
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [siblingId]: { newWorktreesStartFromOrigin: true },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId, siblingId], instanceId, false),
    ).toEqual({
      [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      [siblingId]: {
        newWorktreesStartFromOrigin: true,
        providerInstances: { [instanceId]: { enabled: false } },
      },
    });
  });

  it("resets the only override by clearing the whole project entry", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({ [projectId]: null });
  });

  it("sends providerInstances: {} explicitly when clearing the last instance override leaves other keys", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [instanceId]: { enabled: true } },
        },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({
      [projectId]: { newWorktreesStartFromOrigin: true, providerInstances: {} },
    });
  });
});
