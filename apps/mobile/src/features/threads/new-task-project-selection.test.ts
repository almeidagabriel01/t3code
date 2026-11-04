import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  getProjectScopeSelectionTarget,
  orderScopesByLastProject,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
  resolveNewTaskScratchOption,
} from "./new-task-project-selection";

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/t3tools/t3code",
    title: "T3 Code",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    pinned: false,
    archived: false,
  };
}

describe("getProjectScopeSelectionTarget", () => {
  it("prefers a connected copy of a project that spans environments", () => {
    const mac = makeProject("t3code", "mac");
    const server = makeProject("t3code", "server");
    const target = (connected: ReadonlyArray<string>, preferred: string | null = null) =>
      getProjectScopeSelectionTarget(
        makeScope([mac, server]),
        preferred === null ? null : EnvironmentId.make(preferred),
        new Set(connected.map((id) => EnvironmentId.make(id))),
      );
    expect(target(["server"])).toBe(server);
    expect(target(["server"], "mac")).toBe(server);
    expect(target(["mac", "server"], "server")).toBe(server);
    expect(target(["mac", "server"])).toBe(mac);
    // With nothing connected, the usual order still applies.
    expect(target([], "server")).toBe(server);
    expect(target([])).toBe(mac);
  });
});

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/t3tools/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("t3code", "mac", { workspaceRoot: "/Users/me/t3code" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/t3tools/t3code",
      workspaceRoot: "/Users/me/t3code",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/t3code",
      title: "t3code",
      workspaceRoot: "/home/me/t3code",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/t3code" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });
});

describe("resolveDraftProjectSelection", () => {
  const projects = [makeProject("t3code"), makeProject("t3code-2")];
  const draft = { incomingShareId: undefined, pickerClosed: false };

  it("opens the picker instead of auto-selecting the only project", () => {
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)], draft)).toEqual({
      kind: "pick",
    });
  });

  it("selects the only logical project for shared content", () => {
    expect(
      resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
        ...draft,
        incomingShareId: "share",
      }),
    ).toEqual({ kind: "select", project: projects[0] });
  });

  it("dismisses the draft when the first picker closes without a choice", () => {
    expect(
      resolveDraftProjectSelection(null, projects, [makeScope(projects)], {
        ...draft,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "dismiss" });
  });

  it("keeps the draft when the picker closes after a choice", () => {
    expect(
      resolveDraftProjectSelection("environment:t3code-2", projects, [makeScope(projects)], {
        ...draft,
        pickerClosed: true,
      }),
    ).toEqual({ kind: "preserve" });
  });

  it("keeps a share draft asking for a project when its picker closes without a choice", () => {
    const scopes = [makeScope([projects[0]!]), makeScope([projects[1]!])];
    expect(
      resolveDraftProjectSelection(null, projects, scopes, {
        incomingShareId: "share",
        pickerClosed: true,
      }),
    ).toEqual({ kind: "pick" });
  });
});

describe("orderScopesByLastProject", () => {
  const scope = (id: string, environmentId = "environment") =>
    ({
      key: `${environmentId}:${id}`,
      projectRefs: [{ environmentId, projectId: id }],
    }) as unknown as HomeProjectScope;
  const scopes = [scope("first"), scope("second"), scope("third", "other-environment")];

  it.each([
    {
      name: "moves the last-used project first and marks it",
      last: { environmentId: "environment", projectId: "second" },
      useLast: true,
      order: ["second", "first", "third"],
      lastUsedKey: "environment:second",
    },
    {
      name: "treats an unset preference as on",
      last: { environmentId: "other-environment", projectId: "third" },
      useLast: undefined,
      order: ["third", "first", "second"],
      lastUsedKey: "other-environment:third",
    },
    {
      name: "keeps the order when the preference is off",
      last: { environmentId: "environment", projectId: "second" },
      useLast: false,
      order: ["first", "second", "third"],
      lastUsedKey: null,
    },
    {
      name: "ignores a project id from another environment",
      last: { environmentId: "removed-environment", projectId: "second" },
      useLast: true,
      order: ["first", "second", "third"],
      lastUsedKey: null,
    },
    {
      name: "keeps the order with nothing remembered",
      last: undefined,
      useLast: true,
      order: ["first", "second", "third"],
      lastUsedKey: null,
    },
  ])("$name", ({ last, useLast, order, lastUsedKey }) => {
    const result = orderScopesByLastProject(scopes, {
      ...(last ? { lastThreadProject: last } : {}),
      ...(useLast === undefined ? {} : { useLastProjectForNewThreads: useLast }),
    });
    expect(result.scopes.map((entry) => entry.projectRefs[0]!.projectId)).toEqual(order);
    expect(result.lastUsedKey).toBe(lastUsedKey);
  });
});

describe("resolveNewTaskScratchOption", () => {
  const environmentId = EnvironmentId.make("environment");
  const otherId = EnvironmentId.make("other");
  const configs = new Map([[environmentId, { scratchWorkspaceRoot: "/scratch" }]]);

  it("offers the option from the cached config while the environment is still connecting", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connecting" }],
        serverConfigs: configs,
        selectedEnvironmentId: null,
      }),
    ).toEqual({ environmentId, ready: false });
  });

  it("becomes ready without changing environment once connected", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connected" }],
        serverConfigs: configs,
        selectedEnvironmentId: null,
      }),
    ).toEqual({ environmentId, ready: true });
  });

  it("hides the option when no environment reports a scratch root", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connected" }],
        serverConfigs: new Map([[environmentId, {}]]),
        selectedEnvironmentId: null,
      }),
    ).toBeNull();
    expect(
      resolveNewTaskScratchOption({
        environments: [{ environmentId, connectionState: "connected" }],
        serverConfigs: new Map(),
        selectedEnvironmentId: null,
      }),
    ).toBeNull();
  });

  it("prefers a connected environment over the selected one that is still reconnecting", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [
          { environmentId, connectionState: "reconnecting" },
          { environmentId: otherId, connectionState: "connected" },
        ],
        serverConfigs: new Map([
          [environmentId, { scratchWorkspaceRoot: "/scratch" }],
          [otherId, { scratchWorkspaceRoot: "/other-scratch" }],
        ]),
        selectedEnvironmentId: environmentId,
      }),
    ).toEqual({ environmentId: otherId, ready: true });
  });

  it("keeps the selected environment when every offering environment is connected", () => {
    expect(
      resolveNewTaskScratchOption({
        environments: [
          { environmentId: otherId, connectionState: "connected" },
          { environmentId, connectionState: "connected" },
        ],
        serverConfigs: new Map([
          [environmentId, { scratchWorkspaceRoot: "/scratch" }],
          [otherId, { scratchWorkspaceRoot: "/other-scratch" }],
        ]),
        selectedEnvironmentId: environmentId,
      }),
    ).toEqual({ environmentId, ready: true });
  });
});
