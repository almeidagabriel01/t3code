import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as UserDocs from "../../../userDocs/UserDocs.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DocsToolkit } from "./tools.ts";

const failure = (
  error:
    | UserDocs.UserDocsUnavailableError
    | UserDocs.UserGuideNotFoundError
    | UserDocs.UserGuideCursorError,
) =>
  new OrchestratorMcpFailure({
    code: error._tag === "UserDocsUnavailableError" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(DocsToolkit, {
  t3_docs: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const docs = yield* UserDocs.UserDocs;
      if (input.action === "search") {
        if (input.query === undefined || input.query.trim() === "")
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "search needs `query`.",
          });
        const found = yield* docs
          .search({ query: input.query, limit: input.limit ?? 6 })
          .pipe(Effect.mapError(failure));
        return { ...found };
      }
      if (input.page !== undefined) {
        const read = yield* docs
          .read({ page: input.page, heading: input.heading, cursor: input.cursor })
          .pipe(Effect.mapError(failure));
        return { ...read };
      }
      if (input.heading !== undefined || input.cursor !== undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "`heading` and `cursor` need the `page` they belong to.",
        });
      return { guides: yield* docs.index.pipe(Effect.mapError(failure)) };
    }),
  ),
});
