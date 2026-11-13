import * as M from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { resolveThreadProject } from "./MemorySummaryCommit.ts";
import type { MemoryAccessError, MemoryServiceError } from "./MemoryService.ts";

const STOP = new Set(["the", "and", "for", "did", "does", "what", "that", "this", "with", "about"]);
const MAX_TERMS = 6;

/** Words, minus stop words and common endings, so "deploys" still finds "deploy". */
const recallTerms = (query: string) => {
  const words = query
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  const terms = words
    .filter((word) => word.length >= 3 && !STOP.has(word))
    .map((word) => word.replace(/(?:ing|ed|es|s)$/u, "").replace(/(.{3,})e$/u, "$1"))
    .filter((word) => word.length >= 3);
  return [...new Set(terms.length > 0 ? terms : [query.toLowerCase()])].slice(0, MAX_TERMS);
};

/** More projects than this are searched only up to it; each adds one search per term. */
const MAX_PROJECTS = 12;

/**
 * One query across this conversation, its project (or the named ones, for an assistant that works
 * in several) and the user's memory. Compact on purpose: text and ids only, best match first.
 */
export const makeRecall = (deps: {
  readonly sql: SqlClient.SqlClient;
  readonly environmentId: M.EnvironmentId;
  readonly resolveProjectKey: (
    space: M.MemorySpaceId,
    project: M.ScopedProjectRef,
  ) => Effect.Effect<M.MemoryProjectKey | null, MemoryServiceError>;
  readonly search: (
    input: M.MemorySearchInput,
    permit: Effect.Effect<void, MemoryAccessError>,
    sourceThread?: M.ScopedThreadRef,
  ) => Effect.Effect<M.MemoryPage, MemoryServiceError>;
}) =>
  Effect.fn("MemoryService.recall")(function* (
    input: M.MemoryRecallInput & {
      readonly memorySpaceId: M.MemorySpaceId;
      readonly projectIds?: ReadonlyArray<M.ProjectId> | undefined;
    },
    permit: Effect.Effect<void, MemoryAccessError>,
    sourceThread?: M.ScopedThreadRef,
  ) {
    const space = input.memorySpaceId;
    // ponytail: capped at MAX_PROJECTS; past that, search project keys in one query.
    const named = (input.projectIds ?? []).slice(0, MAX_PROJECTS);
    const namedKeys = yield* Effect.forEach(named, (projectId) =>
      deps
        .resolveProjectKey(space, { environmentId: deps.environmentId, projectId })
        .pipe(Effect.orElseSucceed(() => null)),
    );
    const project =
      named.length > 0
        ? null
        : sourceThread
          ? yield* resolveThreadProject(
              {
                sql: deps.sql,
                environmentId: deps.environmentId,
                resolveProjectKey: deps.resolveProjectKey,
              },
              sourceThread,
              space,
            ).pipe(Effect.catchTags({ SqlError: () => Effect.succeed(null) }))
          : null;
    const scopes: ReadonlyArray<M.MemoryScope> = [
      { kind: "user" },
      ...(project ? [{ kind: "project", projectKey: project.projectKey } as const] : []),
      ...namedKeys.flatMap((projectKey) =>
        projectKey ? [{ kind: "project", projectKey } as const] : [],
      ),
      ...(sourceThread ? [{ kind: "thread", thread: sourceThread } as const] : []),
    ];
    const terms = recallTerms(input.query);
    const found = new Map<string, { hit: M.MemoryRecallHit; matched: number }>();
    let partial = false;
    for (const scope of scopes) {
      for (const term of terms) {
        const run = (mode: "substring" | "fts") =>
          deps.search(
            { memorySpaceId: space, query: term, scope, mode, limit: 20 },
            permit,
            sourceThread,
          );
        // Substring needs the index to be ready; phrase search still works while it builds.
        const page = yield* run("substring").pipe(
          Effect.catchTags({
            MemoryStoreConflict: () => {
              partial = true;
              return run("fts");
            },
          }),
        );
        for (const item of page.items) {
          if (item.status !== "active") continue;
          const entry = found.get(item.memoryId) ?? {
            hit: {
              memoryId: item.memoryId,
              scope: item.scope.kind,
              text: item.payload.text,
              createdAtUtc: item.revision.createdAtUtc,
            },
            matched: 0,
          };
          found.set(item.memoryId, { ...entry, matched: entry.matched + 1 });
        }
      }
    }
    const items = [...found.values()]
      .sort(
        (a, b) =>
          b.matched - a.matched ||
          b.hit.createdAtUtc.localeCompare(a.hit.createdAtUtc) ||
          a.hit.memoryId.localeCompare(b.hit.memoryId),
      )
      .slice(0, input.limit ?? 8)
      .map((entry) => entry.hit);
    return {
      items,
      ...(items.length === 0
        ? { note: "No matches. Rephrase or try single keywords before concluding it is not saved." }
        : partial
          ? { note: "Memory index is still building; results may be incomplete." }
          : {}),
    } satisfies M.MemoryRecallResult;
  });
