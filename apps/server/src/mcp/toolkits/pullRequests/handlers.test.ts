import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  PullRequestOperationError,
  PullRequestUnavailableError,
  type OrchestrationProjectShell,
  type PullRequestRef,
  type PullRequestReviewGuideResult,
  type ThreadPullRequestLink,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as PullRequestSyncReactor from "../../../orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { listThreadPullRequests } from "./handlers.ts";
import { bytesOf, READ_BUDGET_BYTES } from "./readBudget.ts";
import * as PullRequestsHandlers from "./handlers.ts";
import { CHILD_PULL_REQUEST_REPORT_NEXT, PullRequestsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "T3Tools/T3Code",
    owner: "T3Tools",
    name: "T3Code",
  },
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(pullRequests: ReadonlyArray<ThreadPullRequestLink>): PullRequestTestThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  };
}

function makeLink(
  number: number,
  overrides: Partial<ThreadPullRequestLink> & {
    readonly headBranch?: string;
    readonly baseBranch?: string;
  } = {},
): ThreadPullRequestLink {
  const { headBranch, baseBranch, ...rest } = overrides;
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      headBranch === undefined
        ? null
        : {
            state: "open",
            title: `PR ${number}`,
            headBranch,
            baseBranch: baseBranch ?? "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-08-27T00:00:00.000Z",
          },
    stack: null,
    ...rest,
  };
}

interface HarnessOptions {
  readonly thread?: PullRequestTestThread | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly reject?: (command: OrchestrationCommand) => string | null;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly pullRequests?: Partial<PullRequestService.PullRequestService["Service"]>;
  readonly interactionMode?: "default" | "plan";
  readonly receipts?: Partial<CommandReceiptStore.CommandReceiptStoreV2["Service"]>;
  readonly generate?: (
    input: PullRequestRef,
  ) => Effect.Effect<
    PullRequestReviewGuideResult & { started: boolean },
    PullRequestOperationError
  >;
}

const NO_GUIDE: PullRequestReviewGuideResult = { guide: null, run: null, currentHeadSha: "head-1" };

const makeHarness = Effect.fn("makePullRequestsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const guideRequests = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const thread = options.thread === undefined ? makeThread([]) : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null)
        return yield* new Orchestrator.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: rejection,
        });
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1, storedEvents: [] };
    });
  const receipts = new Map<string, CommandReceiptStore.ProjectCommandReceiptV2>();
  const layerDependencies = Layer.mergeAll(
    Layer.mock(PullRequestService.PullRequestService)(options.pullRequests ?? {}),
    Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({ requestSync: () => Effect.void }),
    Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
      getProjectByCommandId: (id) => Effect.succeed(Option.fromNullishOr(receipts.get(id))),
      insertIfAbsent: (receipt) =>
        Effect.sync(() => {
          if (receipts.has(receipt.commandId)) return false;
          receipts.set(receipt.commandId, receipt as CommandReceiptStore.ProjectCommandReceiptV2);
          return true;
        }),
      upsert: (receipt) =>
        Effect.sync(() => {
          receipts.set(receipt.commandId, receipt as CommandReceiptStore.ProjectCommandReceiptV2);
        }),
      ...options.receipts,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          liveThreadShell(id, { interactionMode: options.interactionMode ?? "default" }),
        ),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeed(Option.fromNullishOr(project)),
      listShells: () => Effect.succeed(options.projects ?? (project ? [project] : [])),
    }),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({
      get: () => Effect.succeed(NO_GUIDE),
      generate: (input) =>
        Ref.update(guideRequests, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.generate?.(input) ??
              Effect.succeed({
                ...NO_GUIDE,
                run: {
                  _tag: "Running" as const,
                  headSha: "head-1",
                  startedAt: "2026-10-11T00:00:00.000Z",
                },
                started: true,
              }),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Effect.succeed(id === THREAD_ID && thread ? v2PullRequestThread(thread) : null),
      dispatch,
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(PullRequestsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
    scope: Partial<McpInvocationContext.McpInvocationScope> = {},
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PullRequestsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation(capabilities),
        ...scope,
      }),
      Effect.provide(layerDependencies),
    );
  return { commands, guideRequests, call };
});

describe("pull request toolkit handlers", () => {
  it.effect("refuses a credential without the pull-requests capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_pull_requests", {}, ["preview"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "pull-requests",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links by URL with source agent on the token's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 123,
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.link",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 123,
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("watching an unlinked pull request links it first", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("watch_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(result).toMatchObject({ number: 9, watching: false, wasWatching: false });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.watch",
          number: 9,
          watching: true,
          link: { url: "https://github.com/t3tools/t3code/pull/9", source: "agent" },
        },
      ]);
    }),
  );

  it.effect("refuses to watch a merged pull request and stops an existing watch", () =>
    Effect.gen(function* () {
      const watch = {
        startedAt: "2026-08-20T00:00:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-08-20T00:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      };
      const merged = makeLink(1, { headBranch: "done" });
      const harness = yield* makeHarness({
        thread: makeThread([
          { ...merged, snapshot: merged.snapshot && { ...merged.snapshot, state: "merged" } },
          makeLink(2, { headBranch: "idle" }),
          makeLink(3, { headBranch: "watched", watch }),
        ]),
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestNotOpenError", state: "merged" });
      expect(
        yield* harness.call("unwatch_pull_request", { repository: "t3tools/t3code", number: 3 }),
      ).toMatchObject({ wasWatching: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 3, watching: false },
      ]);
    }),
  );

  it.effect("watches a pull request saved as closed, since it may have reopened", () =>
    Effect.gen(function* () {
      const closed = makeLink(1, { headBranch: "closed" });
      const harness = yield* makeHarness({
        thread: makeThread([
          { ...closed, snapshot: closed.snapshot && { ...closed.snapshot, state: "closed" } },
        ]),
      });
      yield* harness.call("watch_pull_request", { repository: "t3tools/t3code", number: 1 });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 1, watching: true },
      ]);
    }),
  );

  it.effect("refuses a watch from a subagent thread, whose parent owns the pull request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: {
          ...makeThread([makeLink(1, { headBranch: "feature" })]),
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        },
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestWatchFromSubagentError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("asks a subagent thread to end with its PR report after it links", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: {
          ...makeThread([]),
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        },
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/124",
      });
      expect(result).toMatchObject({ number: 124, next: CHILD_PULL_REQUEST_REPORT_NEXT });
    }),
  );

  it.effect("canonicalizes GitCafe links independently of the thread's project host", () =>
    Effect.gen(function* () {
      for (const host of ["git.cafe", "staging.git.cafe"]) {
        for (const project of [makeProject(), makeProject(null)]) {
          for (const target of [
            { host, repository: "PingDotGG/T3Code", number: 21353 },
            { url: `https://${host}/PingDotGG/T3Code/pull/21353` },
            { url: `https://${host}/PingDotGG/T3Code/pulls/21353` },
          ]) {
            const harness = yield* makeHarness({ project });
            const result = yield* harness.call("link_pull_request", target);
            const url = `https://${host}/pingdotgg/t3code/pulls/21353`;
            expect(result).toMatchObject({
              host,
              repository: "pingdotgg/t3code",
              number: 21353,
              url,
            });
            expect(yield* Ref.get(harness.commands)).toMatchObject([
              {
                type: "thread.pull-request.link",
                host,
                repository: "pingdotgg/t3code",
                number: 21353,
                url,
              },
            ]);
          }
        }
      }
    }),
  );

  it.effect("builds the URL in the project host's own shape", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "gitlab.com/group/sub/project",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.com:group/sub/project.git",
          },
          provider: SourceControlProviderKind.make("gitlab"),
          displayName: "group/sub/project",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "group/sub/project",
        number: 42,
      });
      expect(result.url).toBe("https://gitlab.com/group/sub/project/-/merge_requests/42");
      expect(result.host).toBe("gitlab.com");
      const other = yield* harness.call("link_pull_request", {
        host: "gitlab.example.test",
        repository: "team/repo",
        number: 7,
      });
      expect(other.url).toBe("https://gitlab.example.test/team/repo/-/merge_requests/7");
      const onGitHub = yield* harness.call("link_pull_request", {
        host: "github.com",
        repository: "acme/web",
        number: 9,
      });
      expect(onGitHub.url).toBe("https://github.com/acme/web/pull/9");
    }),
  );

  it.effect("links a URL but not a bare number when the project's host is unknown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "scm.example.test/tfs/collection/project/_git/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "http://dummy:secret@scm.example.test:8080/tfs/Collection/Project/_git/Repo",
          },
          provider: SourceControlProviderKind.make("unknown"),
          displayName: "tfs/collection/project/_git/repo",
        }),
      });
      const error = yield* harness
        .call("link_pull_request", { repository: "tfs/Collection/Project/_git/Repo", number: 124 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestUrlUnavailableError" });

      const supplied = "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/123";
      const fromUrl = yield* harness.call("link_pull_request", { url: supplied });
      expect(fromUrl).toEqual({
        host: "scm.example.test",
        repository: "tfs/collection/project/_git/repo",
        number: 123,
        url: supplied,
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.link", number: 123, url: supplied },
      ]);
    }),
  );

  it.effect("treats a duplicate link as alreadyLinked rather than an error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(123)]),
        reject: (command) =>
          command.type === "thread.pull-request.link" ? "already linked" : null,
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/123",
      });
      expect(result.alreadyLinked).toBe(true);
    }),
  );

  it.effect("unlinks a linked pull request and reports a missing one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        reject: (command) =>
          command.type === "thread.pull-request.unlink" && command.number !== 5
            ? "not linked"
            : null,
      });
      const linked = yield* harness.call("unlink_pull_request", {
        repository: "t3tools/t3code",
        number: 5,
      });
      expect(linked).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 5,
        wasLinked: true,
      });
      const missing = yield* harness.call("unlink_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(missing.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 5 },
      ]);
    }),
  );

  it("reports an older Forgejo link's HTTP port when listing thread links", () => {
    const result = listThreadPullRequests(
      makeThread([
        makeLink(42, {
          host: "forge.example",
          url: "http://forge.example:3000/t3tools/t3code/pulls/42",
        }),
      ]),
    );
    expect(result.pullRequests[0]?.host).toBe("forge.example:3000");
  });

  it.effect("lists visible links with host state and derived chain order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([
          makeLink(3, { headBranch: "feat-c", baseBranch: "feat-b", source: "agent" }),
          makeLink(1, { headBranch: "feat-a", baseBranch: "main", source: "created" }),
          makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a", source: "agent" }),
          makeLink(9, { source: "stack-dismissed" }),
          makeLink(10),
        ]),
      });
      const result = yield* harness.call("list_thread_pull_requests", {});
      expect(result.pullRequests.map((entry) => entry.number)).toEqual([3, 1, 2, 10]);
      expect(result.pullRequests[0]).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 3,
        url: "https://github.com/t3tools/t3code/pull/3",
        source: "agent",
        watching: false,
        state: "open",
        title: "PR 3",
        headBranch: "feat-c",
        baseBranch: "feat-b",
        isDraft: false,
        stack: { kind: "derived", position: 3, size: 3 },
      });
      expect(result.pullRequests[3]).toMatchObject({
        number: 10,
        state: null,
        title: null,
        headBranch: null,
        stack: null,
      });
      expect(result.chains).toEqual([
        { kind: "derived", numbers: [1, 2, 3] },
        { kind: "derived", numbers: [10] },
      ]);
    }),
  );
});

describe("listThreadPullRequests", () => {
  it("reports a native stack position for each member", () => {
    const stack = {
      kind: "native" as const,
      id: "stack-1",
      number: 1,
      url: "https://github.com/t3tools/t3code/stack/1",
      base: "main",
      layers: [
        { number: 1, headBranch: "a", state: "open" as const },
        { number: 2, headBranch: "b", state: "open" as const },
      ],
    };
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(2, { stack, source: "stack" }),
        makeLink(1, { stack, source: "created" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [2, { kind: "native", position: 2, size: 2 }],
      [1, { kind: "native", position: 1, size: 2 }],
    ]);
    expect(result.chains).toEqual([{ kind: "native", numbers: [1, 2] }]);
  });

  it("gives pull requests built on the same one the same position", () => {
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(1, { headBranch: "feat-a", baseBranch: "main" }),
        makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a" }),
        makeLink(3, { headBranch: "feat-c", baseBranch: "feat-a" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [1, { kind: "derived", position: 1, size: 3 }],
      [2, { kind: "derived", position: 2, size: 3 }],
      [3, { kind: "derived", position: 2, size: 3 }],
    ]);
    expect(result.chains).toEqual([{ kind: "derived", numbers: [1, 2, 3] }]);
  });
});

describe("pull request guide tools", () => {
  it.effect(
    "writes guides through the project whose checkout is each pull request's repository",
    () =>
      Effect.gen(function* () {
        const other = {
          ...makeProject({
            canonicalKey: "github.com/acme/web",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:acme/web.git",
            },
            provider: SourceControlProviderKind.make("github"),
            displayName: "acme/web",
            owner: "acme",
            name: "web",
          }),
          id: ProjectId.make("project-web"),
        };
        const harness = yield* makeHarness({ projects: [makeProject(), other] });
        const result = yield* harness.call("write_pull_request_guides", {
          pullRequests: [
            { url: "https://github.com/acme/web/pull/7" },
            { repository: "t3tools/t3code", number: 12 },
            { url: "https://github.com/someone/else/pull/1" },
          ],
        });
        expect(
          result.guides.map((guide) => [guide.repository, guide.number, guide.outcome]),
        ).toEqual([
          ["acme/web", 7, "started"],
          ["t3tools/t3code", 12, "started"],
          ["someone/else", 1, "failed"],
        ]);
        expect(result.guides[2]?.detail).toContain("No project in this environment");
        expect(
          (yield* Ref.get(harness.guideRequests)).map((ref) => [ref.projectId, ref.number]),
        ).toEqual([
          ["project-web", 7],
          [PROJECT_ID, 12],
        ]);
      }),
  );

  it.effect("reports an unreadable entry on its own and still writes the rest of the batch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [
          { url: "https://example.com/not-a-pull-request" },
          { repository: "t3tools/t3code" },
          { repository: "t3tools/t3code", number: 5 },
        ],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["failed", "failed", "started"]);
      expect(result.guides[0]?.detail).toContain("not a recognised pull request URL");
      expect(result.guides[1]?.detail).toContain("Pass either url");
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.number)).toEqual([5]);
    }),
  );

  it.effect("finds an Azure DevOps checkout for a pull request named by its full path", () =>
    Effect.gen(function* () {
      const azure = {
        ...makeProject({
          canonicalKey: "dev.azure.com/org/project/_git/web",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://dev.azure.com/org/project/_git/web",
          },
          provider: SourceControlProviderKind.make("azure-devops"),
          displayName: "org/project/_git/web",
          owner: "org",
          name: "web",
        }),
        id: ProjectId.make("project-azure"),
      };
      const harness = yield* makeHarness({ projects: [makeProject(), azure] });
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [{ host: "dev.azure.com", repository: "org/project/_git/web", number: 9 }],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["started"]);
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.projectId)).toEqual([
        "project-azure",
      ]);
    }),
  );
});

const PR = { repository: "t3tools/t3code", number: 5 } as const;

/** Every write the service can take, recording its name and input. */
const recordingService = (
  calls: Array<readonly [string, unknown]>,
  fail?: () => PullRequestOperationError | null,
) => {
  const record = (name: string) => (input: unknown) =>
    Effect.suspend(() => {
      calls.push([name, input]);
      const error = fail?.() ?? null;
      return error === null ? Effect.void : Effect.fail(error);
    });
  return {
    comment: record("comment"),
    updateComment: record("updateComment"),
    submitReview: record("submitReview"),
    replyToThread: record("replyToThread"),
    setThreadResolution: record("setThreadResolution"),
    setReaction: record("setReaction"),
    setLabels: record("setLabels"),
    requestReviewers: record("requestReviewers"),
    update: record("update"),
    runAction: record("runAction"),
  } satisfies Partial<PullRequestService.PullRequestService["Service"]>;
};

describe("pull request agent tools", () => {
  it.effect("cuts a long activity to the read budget and counts what it dropped", () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 100 }, (_, index) => ({
        id: `comment-${index}`,
        body: "x".repeat(2_000),
      }));
      const harness = yield* makeHarness({
        pullRequests: {
          activity: () => Effect.succeed({ comments, reviewThreads: [], commits: [] } as never),
        },
      });
      const result = yield* harness.call("t3_pull_request", { action: "activity", ...PR });
      const kept = (result.activity as { comments: ReadonlyArray<unknown> }).comments.length;
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(comments.length);
      expect((result.omitted as { comments: number }).comments).toBe(comments.length - kept);
      expect(bytesOf(result)).toBeLessThanOrEqual(READ_BUDGET_BYTES);
    }),
  );

  it.effect("cuts a patch to the read budget and says so", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        pullRequests: {
          diff: () =>
            Effect.succeed({ patch: "é".repeat(100_000), truncated: false, nextCursor: null }),
        },
      });
      const result = yield* harness.call("t3_pull_request", { action: "diff", ...PR });
      expect(result.truncated).toBe(true);
      expect(bytesOf(result)).toBeLessThanOrEqual(READ_BUDGET_BYTES);
    }),
  );

  it.effect.each([
    ["comment", { body: "hi" }, "comment", { body: "hi" }],
    [
      "comment_update",
      { commentId: "9", commentKind: "issue-comment", body: "b" },
      "updateComment",
      { commentId: "9", kind: "issue-comment", body: "b" },
    ],
    [
      "review_submit",
      { verdict: "approve", body: "lgtm" },
      "submitReview",
      { verdict: "approve", body: "lgtm", comments: [] },
    ],
    [
      "thread_reply",
      { reviewThreadId: "t1", body: "fixed" },
      "replyToThread",
      { threadId: "t1", body: "fixed" },
    ],
    [
      "thread_resolve",
      { reviewThreadId: "t1", on: false },
      "setThreadResolution",
      { threadId: "t1", resolved: false },
    ],
    ["react", { content: "rocket" }, "setReaction", { content: "rocket", reacted: true }],
    ["labels", { labels: ["bug"], on: false }, "setLabels", { labels: ["bug"], applied: false }],
    [
      "reviewers",
      { reviewers: [{ id: "ana", kind: "user" }] },
      "requestReviewers",
      { reviewers: [{ id: "ana", kind: "user" }], requested: true },
    ],
    ["update", { title: "New" }, "update", { title: "New" }],
    [
      "run",
      { operation: "merge", mergeMethod: "squash" },
      "runAction",
      { action: "merge", mergeMethod: "squash" },
    ],
  ] as const)("routes %s to one service call", ([action, params, method, expected]) =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, unknown]> = [];
      const harness = yield* makeHarness({ pullRequests: recordingService(calls) });
      const result = yield* harness.call("t3_pull_request_write", {
        action,
        clientRequestId: `request-${action}`,
        ...PR,
        ...params,
      } as never);
      expect(result).toMatchObject({ status: "accepted", number: 5 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(method);
      expect(calls[0]?.[1]).toMatchObject({ projectId: PROJECT_ID, number: 5, ...expected });
    }),
  );

  it.effect("sends a write once per clientRequestId and refuses the id for another request", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, unknown]> = [];
      const harness = yield* makeHarness({ pullRequests: recordingService(calls) });
      const write = (body: string) =>
        harness.call("t3_pull_request_write", {
          action: "comment",
          clientRequestId: "same",
          ...PR,
          body,
        });
      expect(yield* write("first")).not.toHaveProperty("replayed");
      expect(yield* write("first")).toMatchObject({ status: "accepted", replayed: true });
      expect(yield* write("other").pipe(Effect.flip)).toMatchObject({
        _tag: "PullRequestWriteRefusedError",
      });
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect(
    "lets a write the service refused before the host go again, but not an unknown one",
    () =>
      Effect.gen(function* () {
        const calls: Array<readonly [string, unknown]> = [];
        let outcome: PullRequestOperationError | null = new PullRequestOperationError({
          operation: "comment",
          detail: "Comments are locked.",
        });
        const harness = yield* makeHarness({
          pullRequests: recordingService(calls, () => outcome),
        });
        const write = (clientRequestId: string) =>
          harness.call("t3_pull_request_write", {
            action: "comment",
            clientRequestId,
            ...PR,
            body: "hi",
          });
        expect(yield* write("a").pipe(Effect.flip)).toMatchObject({
          _tag: "PullRequestWriteRefusedError",
        });
        outcome = null;
        expect(yield* write("a")).toMatchObject({ status: "accepted" });
        expect(calls).toHaveLength(2);

        outcome = new PullRequestOperationError({
          operation: "comment",
          detail: "Timed out.",
          cause: new Error("socket"),
        });
        expect(yield* write("b").pipe(Effect.flip)).toMatchObject({
          _tag: "PullRequestWriteUnconfirmedError",
        });
        outcome = null;
        expect(yield* write("b").pipe(Effect.flip)).toMatchObject({
          _tag: "PullRequestWriteUnconfirmedError",
        });
        expect(calls).toHaveLength(3);
      }),
  );

  it.effect("refuses writes from a plan-mode thread or without the capability", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, unknown]> = [];
      const params = {
        action: "comment",
        clientRequestId: "x",
        ...PR,
        body: "hi",
      } as const;
      const plan = yield* makeHarness({
        interactionMode: "plan",
        pullRequests: recordingService(calls),
      });
      expect(yield* plan.call("t3_pull_request_write", params).pipe(Effect.flip)).toMatchObject({
        code: "capability_denied",
      });
      const open = yield* makeHarness({ pullRequests: recordingService(calls) });
      expect(
        yield* open.call("t3_pull_request_write", params, ["preview"]).pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError" });
      for (const action of ["read", "search"] as const) {
        expect(
          yield* open.call("t3_pull_request", { action, ...PR }, ["preview"]).pipe(Effect.flip),
        ).toMatchObject({ _tag: "McpCapabilityUnavailableError" });
      }
      expect(calls).toEqual([]);
    }),
  );
});

const operationError = (detail: string, cause?: unknown) =>
  new PullRequestOperationError({
    operation: "read",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

describe("pull request reads: unhappy paths", () => {
  it.effect.each([
    ["review_thread without its thread", { action: "review_thread", cursor: "c" }],
    ["review_thread without its cursor", { action: "review_thread", reviewThreadId: "t" }],
    ["file without a path", { action: "file" }],
  ] as const)("refuses %s before reading anything", ([, params]) =>
    Effect.gen(function* () {
      // An empty service throws on any call, so a refusal that reaches it would fail the test.
      const harness = yield* makeHarness();
      expect(
        yield* harness.call("t3_pull_request", { ...PR, ...params }).pipe(Effect.flip),
      ).toMatchObject({
        code: "invalid_request",
      });
    }),
  );

  it.effect.each([
    ["a string that is no URL", { url: "not a url" }, null, "PullRequestUrlInvalidError"],
    [
      "a URL on a host that is no forge",
      { url: "https://example.com/a/b" },
      null,
      "PullRequestUrlInvalidError",
    ],
    [
      "a repository without a number",
      { repository: "t3tools/t3code" },
      null,
      "PullRequestTargetIncompleteError",
    ],
    ["a number without a repository", { number: 5 }, null, "PullRequestTargetIncompleteError"],
    ["no target at all", {}, null, "PullRequestTargetIncompleteError"],
    ["a project with no remote and no host", PR, "no-project", "PullRequestHostRequiredError"],
    [
      "a repository no project holds",
      { url: "https://github.com/other/repo/pull/1" },
      null,
      "PullRequestProjectNotFoundError",
    ],
  ] as const)("refuses %s with its own error", ([, target, project, tag]) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(project === "no-project" ? { project: null } : {});
      for (const action of ["stats", "read"] as const) {
        expect(
          yield* harness.call("t3_pull_request", { action, ...target } as never).pipe(Effect.flip),
        ).toMatchObject({ _tag: tag });
      }
    }),
  );

  it.effect.each([
    ["not found", operationError("Pull request not found.")],
    ["rate limited", operationError("API rate limit exceeded.", new Error("403"))],
    [
      "unauthenticated",
      new PullRequestUnavailableError({
        reason: "cli-unauthenticated",
        requirement: "gh auth login",
      }),
    ],
  ] as const)(
    "reports a host failure (%s) as a read failure with the host's own words",
    ([, failure]) =>
      Effect.gen(function* () {
        const fail = () => Effect.fail(failure);
        const harness = yield* makeHarness({
          pullRequests: {
            detail: fail,
            checks: fail,
            activity: fail,
            diff: fail,
            threadComments: fail,
            diffFileContents: fail,
            listStats: fail,
            list: fail,
          } as never,
        });
        for (const params of [
          { action: "read" },
          { action: "checks" },
          { action: "activity" },
          { action: "diff" },
          { action: "review_thread", reviewThreadId: "t", cursor: "c" },
          { action: "file", path: "a.ts" },
          { action: "stats" },
          { action: "search" },
        ] as const) {
          const error = yield* harness
            .call("t3_pull_request", { ...PR, ...params })
            .pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "PullRequestReadFailedError",
            detail: failure.message,
          });
        }
      }),
  );

  it.effect(
    "passes search defaults and filters through, and clips long rows instead of dropping them",
    () =>
      Effect.gen(function* () {
        const seen: unknown[] = [];
        const harness = yield* makeHarness({
          pullRequests: {
            list: (input: unknown) => {
              seen.push(input);
              return Effect.succeed({
                entries: [
                  {
                    id: "a",
                    url: "https://x/y",
                    title: "t".repeat(5_000),
                    labels: new Array(30).fill("l"),
                  },
                ],
                errors: [],
                truncated: true,
                nextCursors: { repo: "next" },
              } as never);
            },
          },
        });
        const page = yield* harness.call("t3_pull_request", { action: "search" });
        yield* harness.call("t3_pull_request", {
          action: "search",
          state: "closed",
          limit: 3,
          query: "fix",
          cursors: { repo: "c" },
        } as never);
        expect(seen).toEqual([
          { state: "open", limit: 10 },
          { state: "closed", limit: 3, query: "fix", cursors: { repo: "c" } },
        ]);
        expect(page).toMatchObject({
          rowsClipped: true,
          truncated: true,
          nextCursors: { repo: "next" },
        });
        const [row] = page.entries as ReadonlyArray<{ title: string; labels: unknown[] }>;
        expect(row!.title).toHaveLength(1_024);
        expect(row!.labels).toHaveLength(20);
      }),
  );

  it.effect("tells the agent to narrow a search whose clipped rows still exceed the budget", () =>
    Effect.gen(function* () {
      const row = (index: number) => ({ id: `r${index}`, title: "t".repeat(2_000) });
      const harness = yield* makeHarness({
        pullRequests: {
          list: () =>
            Effect.succeed({
              entries: Array.from({ length: 100 }, (_, index) => row(index)),
              errors: [],
              truncated: false,
              nextCursors: {},
            } as never),
        },
      });
      expect(
        yield* harness.call("t3_pull_request", { action: "search", limit: 50 }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "PullRequestReadFailedError",
        detail: expect.stringContaining("Narrow"),
      });
    }),
  );

  it.effect("cuts a review thread to the budget, counts what it dropped and keeps the cursor", () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const comments = Array.from({ length: 100 }, (_, index) => ({
        id: `c${index}`,
        body: "😀".repeat(500),
      }));
      const harness = yield* makeHarness({
        pullRequests: {
          threadComments: (input: unknown) => {
            seen.push(input);
            return Effect.succeed({ comments, nextCursor: "more" } as never);
          },
        },
      });
      const page = yield* harness.call("t3_pull_request", {
        action: "review_thread",
        ...PR,
        reviewThreadId: "thread-9",
        cursor: "start",
      });
      const kept = (page.comments as ReadonlyArray<unknown>).length;
      expect(seen[0]).toMatchObject({ threadId: "thread-9", cursor: "start", number: 5 });
      expect(kept).toBeGreaterThan(0);
      expect(page.omitted).toBe(100 - kept);
      expect(page.nextCursor).toBe("more");
      expect(bytesOf(page)).toBeLessThanOrEqual(READ_BUDGET_BYTES);
    }),
  );

  it.effect("cuts each side of a file to its half of the budget, mapping path defaults", () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const harness = yield* makeHarness({
        pullRequests: {
          diffFileContents: (input: unknown) => {
            seen.push(input);
            return Effect.succeed({
              oldContents: "日".repeat(60_000),
              newContents: "small",
            } as never);
          },
        },
      });
      const file = yield* harness.call("t3_pull_request", {
        action: "file",
        ...PR,
        path: "src/a.ts",
      });
      expect(seen[0]).toMatchObject({
        newPath: "src/a.ts",
        oldPath: "src/a.ts",
        changeType: "change",
      });
      expect(file).toMatchObject({ oldTruncated: true, newTruncated: false, newContents: "small" });
      expect(bytesOf(file)).toBeLessThanOrEqual(READ_BUDGET_BYTES);

      yield* harness.call("t3_pull_request", {
        action: "file",
        ...PR,
        path: "b.ts",
        oldPath: "a.ts",
        changeType: "rename-changed",
        commit: "abc",
      });
      expect(seen[1]).toMatchObject({
        newPath: "b.ts",
        oldPath: "a.ts",
        changeType: "rename-changed",
        commit: "abc",
      });
    }),
  );

  it.effect(
    "keeps a slice the host already marked truncated, and its cursor, when nothing more is cut",
    () =>
      Effect.gen(function* () {
        const seen: unknown[] = [];
        const harness = yield* makeHarness({
          pullRequests: {
            diff: (input: unknown) => {
              seen.push(input);
              return Effect.succeed({ patch: "@@ small", truncated: true, nextCursor: "page-2" });
            },
          },
        });
        const result = yield* harness.call("t3_pull_request", {
          action: "diff",
          ...PR,
          cursor: "page-1",
          commit: "abc",
        });
        expect(seen[0]).toMatchObject({ cursor: "page-1", commit: "abc" });
        expect(result).toMatchObject({ patch: "@@ small", truncated: true, nextCursor: "page-2" });
      }),
  );

  it.effect.each([
    { name: "ascii", unit: "a" },
    { name: "emoji", unit: "😀" },
    { name: "escaped quotes", unit: '"' },
  ])("fits a $name patch under the budget however the cut falls", ({ unit }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        pullRequests: {
          diff: () =>
            Effect.succeed({ patch: unit.repeat(100_000), truncated: false, nextCursor: null }),
        },
      });
      const result = yield* harness.call("t3_pull_request", { action: "diff", ...PR });
      expect(result.truncated).toBe(true);
      expect(bytesOf(result)).toBeLessThanOrEqual(READ_BUDGET_BYTES);
      const patch = result.patch as string;
      expect(patch).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }),
  );

  it.effect("leaves a small activity whole, and fits one whose other fields are huge", () =>
    Effect.gen(function* () {
      const small = { comments: [{ id: "c", body: "hi" }], reviewThreads: [], commits: [] };
      const harness = yield* makeHarness({
        pullRequests: { activity: () => Effect.succeed(small as never) },
      });
      const whole = yield* harness.call("t3_pull_request", { action: "activity", ...PR });
      expect(whole).toMatchObject({
        activity: small,
        omitted: { comments: 0, reviewThreads: 0, commits: 0 },
      });

      const huge = yield* makeHarness({
        pullRequests: {
          activity: () =>
            Effect.succeed({
              summary: "😀".repeat(40_000),
              comments: Array.from({ length: 50 }, (_, index) => ({
                id: `c${index}`,
                body: "x".repeat(900),
              })),
              reviewThreads: [],
              commits: [],
            } as never),
        },
      });
      const cut = yield* huge.call("t3_pull_request", { action: "activity", ...PR });
      expect(bytesOf(cut)).toBeLessThanOrEqual(READ_BUDGET_BYTES);
      const activity = cut.activity as { summary: string; comments: ReadonlyArray<unknown> };
      expect(activity.summary).toHaveLength(512);
      expect((cut.omitted as { comments: number }).comments).toBe(50 - activity.comments.length);
    }),
  );

  it.effect("clips a huge pull request detail and flags it, but leaves a small one unflagged", () =>
    Effect.gen(function* () {
      let detail: object = { title: "t", body: "b".repeat(100_000) };
      const harness = yield* makeHarness({
        pullRequests: { detail: () => Effect.succeed(detail as never) },
      });
      const clipped = yield* harness.call("t3_pull_request", { action: "read", ...PR });
      expect(clipped.clipped).toBe(true);
      expect(bytesOf(clipped)).toBeLessThanOrEqual(READ_BUDGET_BYTES);
      detail = { title: "t", body: "small" };
      expect(yield* harness.call("t3_pull_request", { action: "read", ...PR })).not.toHaveProperty(
        "clipped",
      );
    }),
  );
});

describe("pull request writes: unhappy paths", () => {
  const write = (extra: object, clientRequestId = "id") =>
    ({ clientRequestId, ...PR, ...extra }) as never;

  it.effect.each([
    ["comment without a body", { action: "comment" }],
    [
      "comment_update without a comment",
      { action: "comment_update", commentKind: "issue-comment", body: "b" },
    ],
    ["comment_update without its kind", { action: "comment_update", commentId: "1", body: "b" }],
    [
      "comment_update without a body",
      { action: "comment_update", commentId: "1", commentKind: "issue-comment" },
    ],
    ["review_submit without a verdict", { action: "review_submit" }],
    ["thread_reply without a thread", { action: "thread_reply", body: "b" }],
    ["thread_reply without a body", { action: "thread_reply", reviewThreadId: "t" }],
    ["thread_resolve without a thread", { action: "thread_resolve" }],
    ["react without a reaction", { action: "react" }],
    ["labels without labels", { action: "labels" }],
    ["labels with an empty list", { action: "labels", labels: [] }],
    ["reviewers without reviewers", { action: "reviewers" }],
    ["update with neither title nor body", { action: "update" }],
    ["run without an operation", { action: "run" }],
  ] as const)("refuses %s, calls nothing and keeps the request id free", ([, params]) =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, unknown]> = [];
      const harness = yield* makeHarness({ pullRequests: recordingService(calls) });
      expect(
        yield* harness.call("t3_pull_request_write", write(params)).pipe(Effect.flip),
      ).toMatchObject({
        code: "invalid_request",
      });
      expect(calls).toEqual([]);
      // The same id then goes through with a complete request.
      expect(
        yield* harness.call("t3_pull_request_write", write({ action: "comment", body: "ok" })),
      ).not.toHaveProperty("replayed");
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect(
    "keeps an id to one request: another PR, action or payload is refused, another session is not",
    () =>
      Effect.gen(function* () {
        const calls: Array<readonly [string, unknown]> = [];
        const harness = yield* makeHarness({
          pullRequests: recordingService(calls),
          projects: [makeProject()],
        });
        const send = (params: object, namespace = "provider-session-1") =>
          harness.call("t3_pull_request_write", write(params), ["pull-requests"], {
            requestNamespace: namespace,
          });
        yield* send({ action: "comment", body: "hi" });
        for (const other of [
          { action: "comment", body: "hi", number: 6 },
          { action: "update", body: "hi" },
          { action: "run", operation: "close" },
        ]) {
          expect(yield* send(other).pipe(Effect.flip)).toMatchObject({
            _tag: "PullRequestWriteRefusedError",
            detail: expect.stringContaining("already used"),
          });
        }
        expect(calls).toHaveLength(1);
        // Another session may reuse the same id, and a url for the same PR is the same request.
        yield* send({ action: "comment", body: "hi" }, "provider-session-2");
        expect(calls).toHaveLength(2);
        expect(
          yield* send({
            action: "comment",
            body: "hi",
            repository: undefined,
            number: undefined,
            url: "https://github.com/t3tools/t3code/pull/5",
          }),
        ).toMatchObject({ replayed: true });
        expect(calls).toHaveLength(2);
      }),
  );

  it.effect(
    "sends nothing when the receipt cannot be read or written, and says it may run again",
    () =>
      Effect.gen(function* () {
        const calls: Array<readonly [string, unknown]> = [];
        const commandId = CommandId.make("x");
        const broken = {
          read: new CommandReceiptStore.CommandReceiptStoreReadError({ commandId }),
          write: new CommandReceiptStore.CommandReceiptStoreWriteError({ commandId }),
        };
        for (const receipts of [
          { getProjectByCommandId: () => Effect.fail(broken.read) },
          { insertIfAbsent: () => Effect.fail(broken.write) },
        ] as const) {
          const harness = yield* makeHarness({
            pullRequests: recordingService(calls),
            receipts: receipts as never,
          });
          expect(
            yield* harness
              .call("t3_pull_request_write", write({ action: "comment", body: "hi" }))
              .pipe(Effect.flip),
          ).toMatchObject({
            _tag: "PullRequestWriteRefusedError",
            detail: expect.stringContaining("may run again"),
          });
        }
        expect(calls).toEqual([]);
      }),
  );

  it.effect("treats a lost reservation race as a replay without sending", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, unknown]> = [];
      const harness = yield* makeHarness({
        pullRequests: recordingService(calls),
        receipts: { insertIfAbsent: () => Effect.succeed(false) },
      });
      expect(
        yield* harness.call("t3_pull_request_write", write({ action: "comment", body: "hi" })),
      ).toMatchObject({ status: "accepted", replayed: true });
      expect(calls).toEqual([]);
    }),
  );

  it.effect(
    "maps an unavailable host to refused when nothing was sent and unconfirmed when it may have been",
    () =>
      Effect.gen(function* () {
        let failure: PullRequestUnavailableError = new PullRequestUnavailableError({
          reason: "cli-missing",
        });
        const harness = yield* makeHarness({
          pullRequests: {
            comment: () => Effect.fail(failure),
          } as never,
        });
        const send = (id: string) =>
          harness
            .call("t3_pull_request_write", write({ action: "comment", body: "hi" }, id))
            .pipe(Effect.flip);
        expect(yield* send("a")).toMatchObject({ _tag: "PullRequestWriteRefusedError" });
        failure = new PullRequestUnavailableError({
          reason: "cli-unauthenticated",
          cause: new Error("401"),
        });
        expect(yield* send("b")).toMatchObject({ _tag: "PullRequestWriteUnconfirmedError" });
      }),
  );

  it.effect(
    "refuses a read-only credential and an outside client below full access, calling nothing",
    () =>
      Effect.gen(function* () {
        const calls: Array<readonly [string, unknown]> = [];
        const harness = yield* makeHarness({ pullRequests: recordingService(calls) });
        const params = write({ action: "comment", body: "hi" });
        expect(
          yield* harness
            .call("t3_pull_request_write", params, ["pull-requests"], { readOnly: true })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "capability_denied" });
        expect(calls).toEqual([]);
      }),
  );
});
