import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type { CardUsageTurn } from "./cardUsage.ts";

export interface ThreadFacts {
  readonly threadId: string;
  readonly deleted: boolean;
  readonly title: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly pullRequests: ReadonlyArray<{
    readonly url: string;
    readonly number: number;
    readonly key: string;
    readonly state: string | null;
  }>;
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly status: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  }>;
  readonly turns: ReadonlyArray<CardUsageTurn>;
}

const PullRequestLinks = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      host: Schema.String,
      repository: Schema.String,
      number: Schema.Int,
      url: Schema.String,
      source: Schema.String,
      snapshot: Schema.NullOr(Schema.Struct({ state: Schema.String })),
    }),
  ),
);
const decodePullRequests = Schema.decodeUnknownOption(PullRequestLinks);

const TurnUsage = Schema.fromJsonString(
  Schema.Struct({
    usageStatus: Schema.Literals(["complete", "partial", "unavailable"]),
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
    cachedInputTokens: Schema.optional(Schema.Number),
    cacheCreationTokens: Schema.optional(Schema.Number),
    reasoningTokens: Schema.optional(Schema.Number),
  }),
);
const decodeTurnUsage = Schema.decodeUnknownOption(TurnUsage);

/** Reads thread titles, runs, pull requests and per-turn usage straight from the projection tables. */
export const readThreadFacts = Effect.fn("KanbanThreadFacts.read")(function* (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<string>,
  options: { readonly turns: boolean } = { turns: true },
) {
  if (threadIds.length === 0) return new Map<string, ThreadFacts>();
  const threads = yield* sql<{
    readonly thread_id: string;
    readonly deleted_at: string | null;
    readonly title: string | null;
    readonly branch: string | null;
    readonly worktree_path: string | null;
    readonly pull_requests: string | null;
  }>`
    SELECT thread_id, deleted_at,
      json_extract(payload_json, '$.title') AS title,
      json_extract(payload_json, '$.branch') AS branch,
      json_extract(payload_json, '$.worktreePath') AS worktree_path,
      json_extract(payload_json, '$.pullRequests') AS pull_requests
    FROM orchestration_v2_projection_threads WHERE thread_id IN ${sql.in(threadIds)}`;
  const runs = yield* sql<{
    readonly run_id: string;
    readonly thread_id: string;
    readonly ordinal: number;
    readonly status: string;
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly model: string | null;
  }>`
    SELECT run_id, thread_id, ordinal, status,
      json_extract(payload_json, '$.startedAt') AS started_at,
      json_extract(payload_json, '$.completedAt') AS completed_at,
      json_extract(payload_json, '$.modelSelection.model') AS model
    FROM orchestration_v2_projection_runs WHERE thread_id IN ${sql.in(threadIds)}
    ORDER BY ordinal ASC`;
  type TurnRow = {
    readonly thread_id: string;
    readonly status: string;
    readonly run_id: string | null;
    readonly usage: string | null;
  };
  // Only card detail prices usage; the automation reads skip the per-turn payloads.
  const turns: ReadonlyArray<TurnRow> = options.turns
    ? yield* sql<TurnRow>`
    SELECT turn.thread_id, turn.status, attempt.run_id,
      json_extract(turn.payload_json, '$.turnTokenUsage') AS usage
    FROM orchestration_v2_projection_provider_turns AS turn
    LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
      ON attempt.attempt_id = turn.run_attempt_id
    WHERE turn.thread_id IN ${sql.in(threadIds)}`
    : [];
  const modelByRun = new Map(runs.map((run) => [run.run_id, run.model] as const));
  return new Map(
    threadIds.map((threadId): readonly [string, ThreadFacts] => {
      const row = threads.find((thread) => thread.thread_id === threadId);
      const links =
        row?.pull_requests == null
          ? []
          : Option.getOrElse(decodePullRequests(row.pull_requests), () => []);
      return [
        threadId,
        {
          threadId,
          // No row is not deleted: a card is linked right after its thread launches, possibly
          // before the thread is projected. A row purged by storage cleanup leaves its link behind.
          deleted: row !== undefined && row.deleted_at !== null,
          title: row?.title ?? null,
          branch: row?.branch ?? null,
          worktreePath: row?.worktree_path ?? null,
          pullRequests: links
            .filter((link) => link.source !== "stack-dismissed")
            .map((link) => ({
              url: link.url,
              number: link.number,
              key: `${link.host}/${link.repository}#${link.number}`,
              state: link.snapshot?.state ?? null,
            })),
          runs: runs
            .filter((run) => run.thread_id === threadId)
            .map((run) => ({
              id: run.run_id,
              ordinal: run.ordinal,
              status: run.status,
              startedAt: run.started_at,
              completedAt: run.completed_at,
            })),
          turns: turns
            .filter((turn) => turn.thread_id === threadId)
            .map((turn) => ({
              model: turn.run_id === null ? null : (modelByRun.get(turn.run_id) ?? null),
              status: turn.status,
              usage: turn.usage === null ? null : Option.getOrNull(decodeTurnUsage(turn.usage)),
            })),
        },
      ];
    }),
  );
});
