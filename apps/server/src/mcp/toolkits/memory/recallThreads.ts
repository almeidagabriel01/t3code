import * as M from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const RECALL_THREAD_LIMIT = 5;

/**
 * Past conversations matching a recall query, from the same search as t3_thread_search. Needs
 * the orchestration capability, like that tool. Assistant threads show only to themselves.
 * Never fails a recall: with no search available the result simply has no threads.
 */
export const recallThreads = Effect.fn("memory.recallThreads")(
  function* (query: string) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.capabilities.has("orchestration")) return undefined;
    const search = yield* ThreadSearch.ThreadSearch;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const callerId = scope.thread?.threadId;
    const caller = callerId ? yield* threads.getThreadShell(callerId) : null;
    const { matches } = yield* search.searchThreads({
      query: Array.from(query).slice(0, M.THREAD_SEARCH_QUERY_MAX_LENGTH).join(""),
      // Room to drop assistant threads and still fill the cap.
      limit: RECALL_THREAD_LIMIT * 2,
      projectId: caller?.projectId,
    });
    const found: M.MemoryRecallThread[] = [];
    for (const match of matches) {
      if (found.length === RECALL_THREAD_LIMIT) break;
      if (M.isAssistantThreadId(match.threadId) && match.threadId !== callerId) continue;
      const shell = yield* threads.getThreadShell(match.threadId);
      if (shell === null || shell.deletedAt !== null) continue;
      found.push({
        threadId: match.threadId,
        projectId: match.projectId,
        title: match.title,
        ...(match.snippet ? { snippet: match.snippet } : {}),
        updatedAt: DateTime.formatIso(shell.updatedAt),
      });
    }
    return found;
  },
  Effect.orElseSucceed(() => undefined),
);
