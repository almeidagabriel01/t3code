import * as M from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { Tool, Toolkit } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** JSON Schema presentation only; handlers still decode the original strict contracts. */
const memoryInputSchema = (schema: Schema.Top) => {
  const expose = (ast: SchemaAST.AST): SchemaAST.AST => {
    if (ast._tag === "Declaration" && ast.typeParameters.length === 1)
      return expose(ast.typeParameters[0]!);
    if (ast._tag === "Objects")
      return new SchemaAST.Objects(
        ast.propertySignatures.map(
          (field) => new SchemaAST.PropertySignature(field.name, expose(field.type)),
        ),
        ast.indexSignatures.map(
          (field) => new SchemaAST.IndexSignature(expose(field.parameter), expose(field.type)),
        ),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    if (ast._tag === "Arrays")
      return new SchemaAST.Arrays(
        ast.isMutable,
        ast.elements.map(expose),
        ast.rest.map(expose),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    if (ast._tag === "Union")
      return new SchemaAST.Union(
        ast.types.map(expose),
        ast.options,
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    if (ast._tag === "Suspend")
      return new SchemaAST.Suspend(
        () => expose(ast.thunk()),
        ast.annotations,
        ast.checks,
        ast.encoding,
        ast.context,
      );
    return ast;
  };
  const document = Schema.toJsonSchemaDocument(Schema.make(expose(schema.ast)), {
    onExcessProperty: "error",
  });
  return {
    ...document.schema,
    type: "object" as const,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
  };
};

const failure = Schema.Union([M.MemoryRpcError, M.OrchestratorMcpFailure]);

const SearchTool = Tool.dynamic("memory_search", {
  description:
    "Search memory (default scope: user). fts is phrase search; use mode substring for partial text. Pass nextCursor unchanged with the same query and scope, even when items is empty. If indexCoverage is partial/unavailable, do not conclude a memory is absent.",
  parameters: memoryInputSchema(M.MemorySearchInput),
  success: M.MemoryPage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.enabledWithMemory);

const ListTool = Tool.dynamic("memory_list", {
  description: "List one bounded page of memory items.",
  parameters: memoryInputSchema(M.MemoryListInput),
  success: M.MemoryPage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.enabledWithMemory);

const ReadTool = Tool.dynamic("memory_read", {
  description: "Read one memory item.",
  parameters: memoryInputSchema(M.MemoryReadInput),
  success: M.MemoryItem,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.enabledWithMemory);

const HistoryTool = Tool.dynamic("memory_history", {
  description: "Read one bounded page of a memory item’s revision history.",
  parameters: memoryInputSchema(M.MemoryHistoryInput),
  success: M.MemoryHistoryPage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.enabledWithMemory);

const SyncStatusTool = Tool.dynamic("memory_sync_status", {
  description: "Read memory synchronization status, including disabled or unbound state.",
  parameters: memoryInputSchema(M.MemorySyncStatusInput),
  success: M.MemorySyncStatus,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.enabledWithMemory);

const UpsertTool = Tool.dynamic("memory_upsert", {
  description:
    "Create or update memory with an explicit memory:write grant. Read-only sessions cannot write. Keep one current assertion per item; correct an existing memory by updating it, not creating another. Do not store progress reports, tool output, or execution summaries.",
  parameters: memoryInputSchema(M.MemoryUpsertInput),
  success: M.MemoryMutationReceipt,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.enabledWithMemory);

const ForgetTool = Tool.dynamic("memory_forget", {
  description: "Forget a memory item.",
  parameters: memoryInputSchema(M.MemoryForgetInput),
  success: M.MemoryMutationReceipt,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.enabledWithMemory);

const RevertResolutionTool = Tool.dynamic("memory_revert_resolution", {
  description: "Restore an input revision of a resolved memory item.",
  parameters: memoryInputSchema(M.MemoryRevertResolutionInput),
  success: M.MemoryRevertResult,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.enabledWithMemory);

const ReadSourceTool = Tool.dynamic("memory_read_source", {
  description:
    "Read a memory item’s original conversation evidence through the environment that owns it.",
  parameters: memoryInputSchema(M.MemoryReadSourceInput),
  success: M.MemorySourcePage,
  failure,
  failureMode: "return",
})
  .addDependency(McpInvocationContext.McpInvocationContext)
  .addDependency(MemoryService.MemoryService)
  .addDependency(MemorySyncService.MemorySyncService)
  .addDependency(ThreadManagementService.ThreadManagementService)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.enabledWithMemory);

export const MemoryToolkit = Toolkit.make(
  SearchTool,
  ListTool,
  ReadTool,
  HistoryTool,
  SyncStatusTool,
  UpsertTool,
  ForgetTool,
  RevertResolutionTool,
  ReadSourceTool,
);
