import {
  McpCapabilityUnavailableError,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PositiveInt,
  ProjectId,
  PullRequestAction,
  PullRequestInvolvement,
  PullRequestListCursors,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestReactionContent,
  PullRequestReviewVerdict,
  PullRequestReviewerRequestInput,
  PullRequestUpdateMethod,
  PullRequestReviewGuide,
  PullRequestReviewGuideRun,
  PullRequestState,
  ThreadPullRequestLinkSource,
  TrimmedNonEmptyString,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as PullRequestSyncReactor from "../../../orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  ProjectService.ProjectService,
];

const guideDependencies = [
  ...dependencies,
  PullRequestReviewGuideService.PullRequestReviewGuideService,
];

export const PullRequestTargetInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread. Default: this thread.",
    }),
  ),
  url: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "With `number`, when no `url`.",
    }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({
      description: "With `repository`, when no `url`.",
    }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Default: this project's host.",
    }),
  ),
});
export type PullRequestTargetInput = typeof PullRequestTargetInput.Type;

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a recognised pull request URL. Pass repository and number instead.";
  }
}

export class PullRequestTargetIncompleteError extends Schema.TaggedError<PullRequestTargetIncompleteError>()(
  "PullRequestTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url, or both repository and number.";
  }
}

export class PullRequestHostRequiredError extends Schema.TaggedError<PullRequestHostRequiredError>()(
  "PullRequestHostRequiredError",
  {},
) {
  override get message(): string {
    return "This thread's project has no recognised remote. Pass host or url.";
  }
}

export class PullRequestUrlUnavailableError extends Schema.TaggedError<PullRequestUrlUnavailableError>()(
  "PullRequestUrlUnavailableError",
  {},
) {
  override get message(): string {
    return "This thread's project is on a host with no known pull request URL shape. Pass url.";
  }
}

export class PullRequestThreadRequiredError extends Schema.TaggedError<PullRequestThreadRequiredError>()(
  "PullRequestThreadRequiredError",
  {},
) {
  override get message(): string {
    return "Pass threadId: this MCP client is not running inside a T3 thread.";
  }
}

export class PullRequestThreadNotFoundError extends Schema.TaggedError<PullRequestThreadNotFoundError>()(
  "PullRequestThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class PullRequestLinkFailedError extends Schema.TaggedError<PullRequestLinkFailedError>()(
  "PullRequestLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not link the pull request.";
  }
}

export class PullRequestUnlinkFailedError extends Schema.TaggedError<PullRequestUnlinkFailedError>()(
  "PullRequestUnlinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not unlink the pull request.";
  }
}

export class PullRequestWatchFailedError extends Schema.TaggedError<PullRequestWatchFailedError>()(
  "PullRequestWatchFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not change whether the pull request is watched.";
  }
}

export class PullRequestNotOpenError extends Schema.TaggedError<PullRequestNotOpenError>()(
  "PullRequestNotOpenError",
  { state: Schema.String },
) {
  override get message(): string {
    return `The pull request is ${this.state}, so there is nothing to watch.`;
  }
}

export class PullRequestWatchFromSubagentError extends Schema.TaggedError<PullRequestWatchFromSubagentError>()(
  "PullRequestWatchFromSubagentError",
  {},
) {
  override get message(): string {
    return "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";
  }
}

export class PullRequestListFailedError extends Schema.TaggedError<PullRequestListFailedError>()(
  "PullRequestListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the pull request.";
  }
}

export class PullRequestProjectNotFoundError extends Schema.TaggedError<PullRequestProjectNotFoundError>()(
  "PullRequestProjectNotFoundError",
  { repository: Schema.String },
) {
  override get message(): string {
    return `No project in this environment is a checkout of ${this.repository}, so its pull requests cannot be read here. Add one with t3_project_create.`;
  }
}

export class PullRequestGuideFailedError extends Schema.TaggedError<PullRequestGuideFailedError>()(
  "PullRequestGuideFailedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PullRequestReadFailedError extends Schema.TaggedError<PullRequestReadFailedError>()(
  "PullRequestReadFailedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Refused before any request reached the host, so nothing was posted and the same call may run again. */
export class PullRequestWriteRefusedError extends Schema.TaggedError<PullRequestWriteRefusedError>()(
  "PullRequestWriteRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PullRequestWriteUnconfirmedError extends Schema.TaggedError<PullRequestWriteUnconfirmedError>()(
  "PullRequestWriteUnconfirmedError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The write may have been partly posted. Read the PR (activity) to check. Repeating this clientRequestId will not send it again; use a new one only after confirming it did not post.";
  }
}

export const PullRequestToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestUrlUnavailableError,
  PullRequestThreadRequiredError,
  PullRequestThreadNotFoundError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestWatchFailedError,
  PullRequestNotOpenError,
  PullRequestWatchFromSubagentError,
  PullRequestProjectNotFoundError,
  PullRequestGuideFailedError,
  PullRequestReadFailedError,
  PullRequestWriteRefusedError,
  PullRequestWriteUnconfirmedError,
]);
export type PullRequestToolError = typeof PullRequestToolError.Type;

const PullRequestIdentity = {
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.String,
};

/** A delegated child's report is how its parent learns the PR, so the link result asks for it. */
export const CHILD_PULL_REQUEST_REPORT_NEXT =
  "End your reply with: PR <full URL>, head <SHA>, checks and reviews <state>.";

export const LinkPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  alreadyLinked: Schema.Boolean,
  next: Schema.optional(Schema.String),
});
export type LinkPullRequestResult = typeof LinkPullRequestResult.Type;

export const UnlinkPullRequestResult = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  wasLinked: Schema.Boolean,
});
export type UnlinkPullRequestResult = typeof UnlinkPullRequestResult.Type;

export const WatchPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  watching: Schema.Boolean,
  wasWatching: Schema.Boolean,
});
export type WatchPullRequestResult = typeof WatchPullRequestResult.Type;

export const ThreadPullRequestEntry = Schema.Struct({
  ...PullRequestIdentity,
  source: ThreadPullRequestLinkSource,
  watching: Schema.Boolean,
  state: Schema.NullOr(PullRequestState),
  title: Schema.NullOr(Schema.String),
  headBranch: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  isDraft: Schema.NullOr(Schema.Boolean),
  stack: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** 1-based layer from the bottom; siblings share a layer. */
      position: Schema.Int,
      size: Schema.Int,
    }),
  ),
});
export type ThreadPullRequestEntry = typeof ThreadPullRequestEntry.Type;

export const ListThreadPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(ThreadPullRequestEntry),
  chains: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** Bottom to top; each pull request comes before the ones built on it. */
      numbers: Schema.Array(Schema.Int),
    }),
  ),
});
export type ListThreadPullRequestsResult = typeof ListThreadPullRequestsResult.Type;

const LinkPullRequestTool = Tool.make("link_pull_request", {
  description: "Link a PR to this thread. T3 shows its status and settles the thread on merge.",
  parameters: PullRequestTargetInput,
  success: LinkPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link pull request to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkPullRequestTool = Tool.make("unlink_pull_request", {
  description:
    "Remove a PR link from this thread. Succeeds with `wasLinked=false` when it was not linked.",
  parameters: PullRequestTargetInput,
  success: UnlinkPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink pull request from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadPullRequestsTool = Tool.make("list_thread_pull_requests", {
  description:
    "List PRs linked to a thread, with last known state and stack order (bottom to top). Call only when you need that list. Never as an end-of-work check.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId.annotate({ description: "Thread. Default: this thread." })),
  }),
  success: ListThreadPullRequestsResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread pull requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WatchPullRequestTool = Tool.make("watch_pull_request", {
  description:
    "Watch an open PR for this thread, linking it first if needed. T3 wakes you on failed checks, passed required checks, new comments or reviews, or conflicts. Handle old comments first. Only later ones wake you. After this call, end your turn. The watch stays on after each wake, so do not call this again on a wake. A wake is not a merge decision. Check readiness yourself.",
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Watch pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const UnwatchPullRequestTool = Tool.make("unwatch_pull_request", {
  description: "Stop watching a PR for this thread. It stays linked.",
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop watching pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const GuideTarget = Schema.Struct({
  url: PullRequestTargetInput.fields.url,
  repository: PullRequestTargetInput.fields.repository,
  number: PullRequestTargetInput.fields.number,
  host: PullRequestTargetInput.fields.host,
});

const GuideOutcome = Schema.Struct({
  ...PullRequestIdentity,
  outcome: Schema.Literals(["started", "running", "failed"]).annotate({
    description: "started: a run began. running: joined a run for this head. failed: see detail.",
  }),
  detail: Schema.NullOr(Schema.String),
});

export const WritePullRequestGuidesResult = Schema.Struct({
  guides: Schema.Array(GuideOutcome),
});
export type WritePullRequestGuidesResult = typeof WritePullRequestGuidesResult.Type;

export const ReadPullRequestGuideResult = Schema.Struct({
  ...PullRequestIdentity,
  guide: Schema.NullOr(PullRequestReviewGuide),
  run: Schema.NullOr(PullRequestReviewGuideRun),
  currentHeadSha: Schema.NullOr(Schema.String),
  stale: Schema.Boolean.annotate({
    description: "True when the PR head moved after the guide was written.",
  }),
});
export type ReadPullRequestGuideResult = typeof ReadPullRequestGuideResult.Type;

const WritePullRequestGuidesTool = Tool.make("write_pull_request_guides", {
  description:
    "Write review guides for up to 20 PRs (the tour in the PR Guide tab). Returns once runs start. Each run takes minutes in a temporary checkout. A run for the same head is joined. Read with `read_pull_request_guide`. Fails while guides are off.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    pullRequests: Schema.Array(GuideTarget).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  }),
  success: WritePullRequestGuidesResult,
  failure: PullRequestToolError,
  dependencies: guideDependencies,
})
  .annotate(Tool.Title, "Write pull request guides")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ReadPullRequestGuideTool = Tool.make("read_pull_request_guide", {
  description:
    "Read a PR's stored review guide and run state. `guide` is null when none exists. Never starts a run.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...GuideTarget.fields,
  }),
  success: ReadPullRequestGuideResult,
  failure: PullRequestToolError,
  dependencies: guideDependencies,
})
  .annotate(Tool.Title, "Read pull request guide")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ReadTarget = Schema.Struct({
  url: PullRequestTargetInput.fields.url,
  repository: PullRequestTargetInput.fields.repository,
  number: PullRequestTargetInput.fields.number,
  host: PullRequestTargetInput.fields.host,
});

const PULL_REQUEST_READ_ACTIONS = [
  "read",
  "checks",
  "activity",
  "diff",
  "review_thread",
  "file",
  "search",
  "stats",
] as const;

export const PullRequestReadParameters = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  action: Schema.Literals(PULL_REQUEST_READ_ACTIONS),
  ...ReadTarget.fields,
  reviewThreadId: Schema.optional(TrimmedNonEmptyString),
  cursor: Schema.optional(TrimmedNonEmptyString),
  commit: Schema.optional(TrimmedNonEmptyString),
  path: Schema.optional(TrimmedNonEmptyString),
  oldPath: Schema.optional(TrimmedNonEmptyString),
  changeType: Schema.optional(
    Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  ),
  state: Schema.optional(PullRequestListState),
  involvement: Schema.optional(PullRequestInvolvement),
  filters: Schema.optional(PullRequestListFilters),
  projectId: Schema.optional(ProjectId),
  query: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
  cursors: Schema.optional(PullRequestListCursors),
});
export type PullRequestReadParameters = typeof PullRequestReadParameters.Type;

const PullRequestReadTool = Tool.make("t3_pull_request", {
  description:
    "Read a pull request from its host. Name it by `url`, or `repository` + `number` (+ `host`). `read`: details. `checks`: CI. `activity`: reviews, comments, commits. `diff`: patch, `cursor` pages. `review_thread`: `reviewThreadId` + the thread's `cursor`. `file`: `path` (`oldPath`, `changeType`) before/after contents. `search`: list PRs by `state` (default open), `query`, `filters`, `involvement`, `projectId`, `limit` (default 10), `cursors`. `stats`: diff size. Long output is cut at 64 KiB and says so.",
  parameters: PullRequestReadParameters,
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: PullRequestToolError,
  dependencies: [...dependencies, PullRequestService.PullRequestService],
})
  .annotate(Tool.Title, "Read pull request")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const PULL_REQUEST_WRITE_ACTIONS = [
  "comment",
  "comment_update",
  "review_submit",
  "thread_reply",
  "thread_resolve",
  "react",
  "labels",
  "reviewers",
  "update",
  "run",
] as const;

/** Merge, close and the other state changes `run` may start; deleting branches, reverting and approving workflows stay with the user. */
export const PullRequestRunOperation = Schema.Literals([
  "merge",
  "close",
  "reopen",
  "ready",
  "draft",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
] as const satisfies ReadonlyArray<PullRequestAction>);

export const PullRequestWriteParameters = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
    description:
      "Your own id for this write. Retrying with the same id does not post twice. New write, new id.",
  }),
  action: Schema.Literals(PULL_REQUEST_WRITE_ACTIONS),
  ...ReadTarget.fields,
  body: Schema.optional(Schema.String),
  title: Schema.optional(TrimmedNonEmptyString),
  commentId: Schema.optional(TrimmedNonEmptyString),
  commentKind: Schema.optional(Schema.Literals(["issue-comment", "review-comment"])),
  verdict: Schema.optional(PullRequestReviewVerdict),
  reviewThreadId: Schema.optional(TrimmedNonEmptyString),
  subjectId: Schema.optional(TrimmedNonEmptyString),
  content: Schema.optional(PullRequestReactionContent),
  labels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  reviewers: Schema.optional(PullRequestReviewerRequestInput.fields.reviewers),
  on: Schema.optional(Schema.Boolean),
  operation: Schema.optional(PullRequestRunOperation),
  mergeMethod: Schema.optional(PullRequestMergeMethod),
  updateMethod: Schema.optional(PullRequestUpdateMethod),
});
export type PullRequestWriteParameters = typeof PullRequestWriteParameters.Type;

export const PullRequestWriteResult = Schema.Struct({
  ...PullRequestIdentity,
  status: Schema.Literal("accepted"),
  replayed: Schema.optional(Schema.Boolean),
});

const PullRequestWriteTool = Tool.make("t3_pull_request_write", {
  description:
    "Change a pull request on its host, as the signed-in user. Same target fields as `t3_pull_request`; `clientRequestId` is required. `comment`: `body`. `comment_update`: `commentId`, `commentKind`, `body`. `review_submit`: `verdict`, `body`. `thread_reply`: `reviewThreadId`, `body`. `thread_resolve`: `reviewThreadId`; `on: false` reopens. `react`: `content`, optional `subjectId` (default the PR); `on: false` removes. `labels`: `labels`; `on: false` removes. `reviewers`: `reviewers`; `on: false` cancels the request. `update`: `title` and/or `body`. `run`: `operation` (merge with `mergeMethod`, close, reopen, ready, draft, update-branch with `updateMethod`, enable-auto-merge, disable-auto-merge). Only on the user's ask: others see it. Needs a thread in default mode.",
  parameters: PullRequestWriteParameters,
  success: PullRequestWriteResult,
  failure: PullRequestToolError,
  dependencies: [
    ...dependencies,
    PullRequestService.PullRequestService,
    PullRequestSyncReactor.PullRequestSyncReactor,
    CommandReceiptStore.CommandReceiptStoreV2,
  ],
})
  .annotate(Tool.Title, "Change pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const PullRequestsToolkit = Toolkit.make(
  PullRequestReadTool,
  PullRequestWriteTool,
  LinkPullRequestTool,
  UnlinkPullRequestTool,
  ListThreadPullRequestsTool,
  WatchPullRequestTool,
  UnwatchPullRequestTool,
  WritePullRequestGuidesTool,
  ReadPullRequestGuideTool,
);
