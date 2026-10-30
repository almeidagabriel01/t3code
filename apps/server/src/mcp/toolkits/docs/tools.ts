import { NonNegativeInt, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as UserDocs from "../../../userDocs/UserDocs.ts";

const DocsTool = Tool.make("t3_docs", {
  description:
    "T3 Code's own user guides. Use for how-to or settings questions about T3 Code itself (Settings, providers, memory, notes, remote access), not for the user's code. `search`: `query` returns ranked sections (page, heading, snippet); `limit` default 6. `read`: `page` (+ `heading` from search) returns its markdown, `cursor` continues a long one; without `page` it lists the guides.",
  parameters: Schema.Struct({
    action: Schema.Literals(["search", "read"]),
    query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
    page: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    heading: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
    cursor: Schema.optional(NonNegativeInt),
  }),
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [UserDocs.UserDocs],
})
  .annotate(Tool.Title, "T3 Code user guides")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DocsToolkit = Toolkit.make(DocsTool);
