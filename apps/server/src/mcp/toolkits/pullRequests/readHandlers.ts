import { OrchestratorMcpFailure, type PullRequestRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { bytesOf, clipFields, clipJsonText, fitItems, READ_BUDGET_BYTES } from "./readBudget.ts";
import {
  PullRequestReadFailedError,
  type PullRequestReadParameters,
  type PullRequestsToolkit,
  type PullRequestTargetInput,
  type PullRequestToolError,
} from "./tools.ts";

const SEARCH_LIMIT = 10;
// Measured in place of each omitted count, so the shell never grows after the lists are fitted.
const WIDEST_COUNT = 999_999_999;
const ACTIVITY_LISTS = ["reviewers", "comments", "reviewThreads", "commits", "reactions"] as const;

export type Locate = (input: Omit<PullRequestTargetInput, "threadId">) => Effect.Effect<
  {
    readonly target: {
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly url: string;
    };
    readonly ref: PullRequestRef;
  },
  PullRequestToolError,
  McpInvocationContext.McpInvocationContext
>;

const readFailure = (error: { readonly message: string }) =>
  new PullRequestReadFailedError({ detail: error.message, cause: error });

const need = <T>(value: T | undefined, name: string, action: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${action} needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);

/** A value as is when it fits the read budget, else with long text and lists clipped. */
const fitted = <A>(value: A) => {
  if (bytesOf(value) <= READ_BUDGET_BYTES) return { value, clipped: false };
  const clip = clipFields(value);
  return { value: clip.value, clipped: true };
};

/** Every list of an activity shares what its other fields leave, in order; each says how many it dropped. */
const fitActivity = (activity: Record<string, unknown>) => {
  const emptied = { ...activity };
  for (const key of ACTIVITY_LISTS) if (Array.isArray(emptied[key])) emptied[key] = [];
  const shell = fitted({
    activity: emptied,
    omitted: Object.fromEntries(ACTIVITY_LISTS.map((key) => [key, WIDEST_COUNT])),
  });
  let left = Math.max(0, READ_BUDGET_BYTES - bytesOf(shell.value));
  const omitted: Record<string, number> = {};
  const lists: Record<string, unknown> = {};
  for (const key of ACTIVITY_LISTS) {
    const items = activity[key];
    if (!Array.isArray(items)) continue;
    const fit = fitItems(items, left);
    left -= fit.used;
    lists[key] = fit.kept;
    omitted[key] = fit.omitted;
  }
  return { activity: { ...shell.value.activity, ...lists }, omitted };
};

export const makePullRequestReadHandlers = (
  pullRequests: PullRequestService.PullRequestService["Service"],
  locate: Locate,
) => {
  const run = Effect.fn("PullRequestsToolkit.read")(function* (input: PullRequestReadParameters) {
    // Search names no PR, so the capability check inside `locate` would never run.
    yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const { action } = input;
    switch (action) {
      case "search": {
        const { state, limit, ...rest } = input;
        const result = yield* pullRequests
          .list({
            state: state ?? "open",
            limit: limit ?? SEARCH_LIMIT,
            ...(rest.involvement === undefined ? {} : { involvement: rest.involvement }),
            ...(rest.filters === undefined ? {} : { filters: rest.filters }),
            ...(rest.projectId === undefined ? {} : { projectId: rest.projectId }),
            ...(rest.host === undefined ? {} : { host: rest.host }),
            ...(rest.query === undefined ? {} : { query: rest.query }),
            ...(rest.cursors === undefined ? {} : { cursors: rest.cursors }),
          })
          .pipe(Effect.mapError(readFailure));
        // Cursors are per repository, so dropping rows would skip them on the next page; clipping
        // each row keeps one row small enough that narrowing always fits.
        const rows = result.entries.map(clipFields);
        const page = {
          entries: rows.map((row) => row.value),
          rowsClipped: rows.some((row) => row.clipped),
          errors: result.errors,
          truncated: result.truncated,
          nextCursors: result.nextCursors,
        };
        if (bytesOf(page) > READ_BUDGET_BYTES)
          return yield* new PullRequestReadFailedError({
            detail:
              "These results exceed 64 KiB. Narrow with projectId, query or filters, or lower limit.",
          });
        return page;
      }
      default:
    }

    const { target, ref } = yield* locate(input);
    const identity = { ...target };
    switch (action) {
      case "read": {
        // Fresh like the pull request view, not the held copy a list row may show.
        const detail = yield* pullRequests
          .detail({ ...ref, allowStale: false })
          .pipe(Effect.mapError(readFailure));
        const { value, clipped } = fitted(detail);
        return { ...identity, pullRequest: value, ...(clipped ? { clipped } : {}) };
      }
      case "checks": {
        const checks = yield* pullRequests.checks(ref).pipe(Effect.mapError(readFailure));
        const { value, clipped } = fitted(checks);
        return { ...identity, checks: value, ...(clipped ? { clipped } : {}) };
      }
      case "activity": {
        const activity = yield* pullRequests.activity(ref).pipe(Effect.mapError(readFailure));
        return { ...identity, ...fitActivity({ ...activity }) };
      }
      case "diff": {
        const result = yield* pullRequests
          .diff({
            ...ref,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.commit === undefined ? {} : { commit: input.commit }),
          })
          .pipe(Effect.mapError(readFailure));
        const rest = bytesOf({ ...identity, ...result, patch: "", truncated: false });
        const cut = clipJsonText(result.patch, READ_BUDGET_BYTES - rest);
        return {
          ...identity,
          ...result,
          patch: cut.text,
          truncated: result.truncated || cut.truncated,
        };
      }
      case "review_thread": {
        const page = yield* pullRequests
          .threadComments({
            ...ref,
            threadId: yield* need(input.reviewThreadId, "reviewThreadId", action),
            cursor: yield* need(input.cursor, "cursor", action),
          })
          .pipe(Effect.mapError(readFailure));
        const shell = {
          ...identity,
          comments: [],
          nextCursor: page.nextCursor,
          omitted: WIDEST_COUNT,
        };
        const comments = fitItems(page.comments, Math.max(0, READ_BUDGET_BYTES - bytesOf(shell)));
        return { ...shell, comments: comments.kept, omitted: comments.omitted };
      }
      case "file": {
        const path = yield* need(input.path, "path", action);
        const file = yield* pullRequests
          .diffFileContents({
            ...ref,
            ...(input.commit === undefined ? {} : { commit: input.commit }),
            changeType: input.changeType ?? "change",
            oldPath: input.oldPath ?? path,
            newPath: path,
          })
          .pipe(Effect.mapError(readFailure));
        const half = (READ_BUDGET_BYTES - bytesOf(identity)) / 2 - 64;
        const before = clipJsonText(file.oldContents, half);
        const after = clipJsonText(file.newContents, half);
        return {
          ...identity,
          oldContents: before.text,
          newContents: after.text,
          oldTruncated: before.truncated,
          newTruncated: after.truncated,
        };
      }
      default: {
        const { stats } = yield* pullRequests
          .listStats({ refs: [ref] })
          .pipe(Effect.mapError(readFailure));
        return { ...identity, stats };
      }
    }
  });

  return {
    t3_pull_request: McpToolAccess.reads(run),
  } satisfies Pick<McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>, "t3_pull_request">;
};
