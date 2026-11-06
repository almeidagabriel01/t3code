import * as M from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./MemoryStore.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
import type { MemoryServiceError } from "./MemoryService.ts";
import type { SummaryRules } from "./memorySummaryChunks.ts";

export type SummaryPromotionCommit = {
  /** The final chunk's input, which the candidates cite. */
  readonly input: M.GenerateMemorySummaryInput;
  readonly candidates: NonNullable<M.GenerateMemorySummaryOutcome["promotions"]>;
  readonly execution: M.MemoryGenerationExecution;
  /** The thread's project and the key it resolved to before the transaction, or null. */
  readonly project: {
    readonly project: M.ScopedProjectRef;
    readonly projectKey: M.MemoryProjectKey;
  } | null;
};
export type SummaryRulesCommit = {
  readonly batches: ReadonlyArray<SummaryRules>;
  readonly project: SummaryPromotionCommit["project"];
};
export type SummaryCommit = {
  readonly work: Store.MemoryWork;
  /** Null when the run found nothing durable: only its promotions, if any, are written. */
  readonly generated: M.GenerateMemorySummaryExecutionResult | null;
  readonly input: M.GenerateMemorySummaryInput;
  readonly expectedHeads: ReadonlyArray<M.MemoryRevisionId>;
  /** Re-read committed source/exclusions inside the commit transaction. */
  readonly recheckSource: Effect.Effect<void, MemoryServiceError>;
  readonly promotions?: SummaryPromotionCommit | undefined;
  readonly rules?: SummaryRulesCommit | undefined;
};

const strict = { onExcessProperty: "error" } as const;
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(M.MemoryModelSelection));
const encodeHeads = Schema.encodeSync(Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)));
const encodeScope = Schema.encodeSync(Schema.fromJsonString(M.MemoryScope));
const encodeProjectKey = Schema.encodeSync(Schema.fromJsonString(M.MemoryProjectKey));
const decodeSummary = Schema.decodeUnknownEffect(M.GenerateMemorySummaryExecutionResult);
const decodeSummaryPayload = Schema.decodeEffect(M.MemoryPayload);
const invalid = () => new Store.MemoryStoreConflict({ code: "invalid_output" });
const decode = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(invalid));

/** Repository discovery can run here, outside SQL; the commit rechecks the binding it used. */
export const resolveThreadProject = Effect.fn("MemoryWorker.resolveThreadProject")(function* (
  deps: {
    readonly sql: SqlClient.SqlClient;
    readonly environmentId: M.EnvironmentId;
    readonly resolveProjectKey: (
      space: M.MemorySpaceId,
      project: M.ScopedProjectRef,
    ) => Effect.Effect<M.MemoryProjectKey | null, MemoryServiceError>;
  },
  thread: M.ScopedThreadRef,
  space: M.MemorySpaceId,
) {
  const rows = yield* deps.sql<{
    project_id: string | null;
  }>`SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=${thread.threadId}`;
  const projectId = rows[0]?.project_id;
  if (!projectId) return null;
  const project = { environmentId: deps.environmentId, projectId: M.ProjectId.make(projectId) };
  // A project removed since the run leaves only the user-wide promotion.
  const projectKey = yield* deps.resolveProjectKey(space, project).pipe(
    Effect.catchTags({
      MemoryStoreConflict: () => Effect.succeed(null),
      MemoryAccessError: () => Effect.succeed(null),
    }),
  );
  return projectKey ? { project, projectKey } : null;
});

export const makeCommitSummary = (deps: {
  readonly store: Store.MemoryStore["Service"];
  readonly sql: SqlClient.SqlClient;
  readonly environmentId: M.EnvironmentId;
  readonly apply: (
    op: M.MemoryOperation,
    admission: Store.MemoryAdmissionContext,
    permit: Effect.Effect<void>,
  ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
  readonly validateDependencies: (
    space: M.MemorySpaceId,
    payload: M.MemoryPayload,
  ) => Effect.Effect<void, MemoryServiceError>;
  readonly forget: (input: M.MemoryForgetInput) => Effect.Effect<unknown, MemoryServiceError>;
  readonly stableUuid: (text: string) => string;
}) => {
  const { store, environmentId, apply } = deps;
  const now = Effect.map(Clock.currentTimeMillis, (millis) =>
    M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );
  /**
   * Writes durable project/user candidates beside the summary, in its transaction, so a retry
   * replays them with the same ids. Each depends on the summary revision: forgetting the source
   * thread's memory removes them too. A forgotten promotion is never recreated, and one that
   * cannot be admitted (capacity, a concurrent edit) is skipped without failing the summary.
   */
  const promote = Effect.fnUntraced(function* (
    commit: SummaryCommit,
    summaryRevision: M.MemoryRevisionId,
    summaryDependencies: ReadonlyArray<M.MemoryRevisionId>,
  ) {
    const promotions = commit.promotions;
    const meta = commit.work.metadata;
    if (!promotions || meta.kind !== "summary") return;
    const execution = promotions.execution;
    if (
      execution.environmentId !== environmentId ||
      execution.providerInstanceId !== meta.modelSelection.instanceId ||
      encodeSelection(execution.requestedModelSelection) !== encodeSelection(meta.modelSelection)
    )
      return;
    const space = M.MemorySpaceId.make(commit.work.space);
    for (const destination of ["project", "user"] as const) {
      const candidate = promotions.candidates[destination];
      if (!candidate || !M.validateMemoryGenerationResult(promotions.input, candidate)) continue;
      if (!candidate.evidence.some((evidence) => evidence.origin !== "model")) continue;
      if (scanMemoryValue(candidate).kind !== "allowed") continue;
      let scope: M.MemoryScope = { kind: "user" };
      let key = "user";
      if (destination === "project") {
        if (!promotions.project) continue;
        const binding = yield* store.getProjectBinding(space, promotions.project.project);
        const projectKey = promotions.project.projectKey;
        // The key was resolved outside this transaction; a rebinding since then wins.
        if (
          !binding?.projectKey ||
          encodeProjectKey(binding.projectKey) !== encodeProjectKey(projectKey)
        )
          continue;
        scope = { kind: "project", projectKey };
        key = `project:${encodeProjectKey(projectKey)}`;
      }
      const thread = meta.sourceThread;
      const memoryId = M.MemoryId.make(
        deps.stableUuid(`${thread.environmentId}:${thread.threadId}:promotion:${key}`),
      );
      const operationId = M.MemoryOperationId.make(
        deps.stableUuid(`${commit.work.id}:promotion:${key}:operation`),
      );
      const revisionId = M.MemoryRevisionId.make(
        deps.stableUuid(`${commit.work.id}:promotion:${key}:revision`),
      );
      const written = Effect.gen(function* () {
        const current = yield* store.loadAggregate(space, memoryId, { heads: true }, {});
        if (current.tombstone || current.pendingForget || current.heads.length > 1) return;
        const head = current.revisions.find((p) => p.revision.revisionId === current.heads[0]);
        const owner = head?.revision.provenance.sourceThread;
        // Only this thread's own promotion is replaced; an edit, import or resolution stays.
        if (
          head &&
          (owner?.environmentId !== thread.environmentId || owner.threadId !== thread.threadId)
        )
          return;
        const payload = yield* decode(
          decodeSummaryPayload(
            {
              text: M.stripMemoryRulePrefix(candidate.text),
              evidence: candidate.evidence,
              derivedFromMemoryRevisions: [...new Set([summaryRevision, ...summaryDependencies])],
            },
            strict,
          ),
        );
        yield* deps.validateDependencies(space, payload);
        yield* apply(
          {
            protocolVersion: 1,
            kind: "upsert",
            memorySpaceId: space,
            memoryId,
            operationId,
            originEnvironmentId: environmentId,
            expectedHeads: current.heads,
            payload,
            revision: {
              memorySpaceId: space,
              memoryId,
              revisionId,
              operationId,
              parents: current.heads,
              scope,
              payloadRef: revisionId,
              assertionKind: candidate.assertionKind,
              createdAtUtc: yield* now,
              provenance: {
                environmentId,
                providerInstanceId: execution.providerInstanceId,
                provider: execution.effectiveProvider,
                requestedModelSelection: execution.requestedModelSelection,
                effectiveModel: execution.effectiveModel,
                sourceThread: thread,
                sourceWatermark: meta.sourceWatermark,
              },
            },
          },
          Store.localIntent,
          Effect.void,
        );
      });
      // Inside the summary's transaction this is a savepoint: a refused promotion rolls back alone.
      yield* deps.sql.withTransaction(written).pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(new Store.MemoryStorageError({ stage: "summary-promotion", cause })),
          MemoryCapacityError: () => Effect.void,
          MemoryStoreConflict: () => Effect.void,
        }),
      );
    }
  });
  /**
   * Writes the user's standing rules beside the summary, in its transaction. A rule's id derives
   * from scope and text, so a retry lands on the same memory and a forgotten rule stays forgotten.
   * One that supersedes an active rule of the same scope forgets it in the same savepoint; one that
   * cannot be admitted is skipped without failing the summary.
   */
  const commitRules = Effect.fnUntraced(function* (commit: SummaryCommit) {
    const rules = commit.rules;
    const meta = commit.work.metadata;
    if (!rules || meta.kind !== "summary") return;
    const space = M.MemorySpaceId.make(commit.work.space);
    const thread = meta.sourceThread;
    for (const batch of rules.batches) {
      const execution = batch.execution;
      if (
        execution.environmentId !== environmentId ||
        execution.providerInstanceId !== meta.modelSelection.instanceId ||
        encodeSelection(execution.requestedModelSelection) !== encodeSelection(meta.modelSelection)
      )
        continue;
      for (const rule of batch.rules) {
        const body = M.stripMemoryRulePrefix(rule.text.trim()).trim();
        const evidence = [
          {
            origin: "thread" as const,
            sourceThread: batch.input.sourceThread,
            watermark: batch.input.sourceWatermark,
            messageIds: rule.messageIds,
          },
        ];
        const typed = new Set<string>(batch.input.rules?.userTypedMessageIds);
        if (
          !body ||
          !rule.messageIds.length ||
          !rule.messageIds.every((id) => typed.has(id)) ||
          !M.validateMemoryGenerationResult(batch.input, {
            text: body,
            assertionKind: "fact",
            evidence,
          }) ||
          scanMemoryValue({ text: body }).kind !== "allowed"
        )
          continue;
        let scope: M.MemoryScope = { kind: "user" };
        let key = "user";
        if (rule.scope === "project") {
          if (!rules.project) continue;
          const binding = yield* store.getProjectBinding(space, rules.project.project);
          const projectKey = rules.project.projectKey;
          if (
            !binding?.projectKey ||
            encodeProjectKey(binding.projectKey) !== encodeProjectKey(projectKey)
          )
            continue;
          scope = { kind: "project", projectKey };
          key = `project:${encodeProjectKey(projectKey)}`;
        }
        const normalized = body.normalize("NFC").replace(/\s+/g, " ").toLowerCase();
        const memoryId = M.MemoryId.make(deps.stableUuid(`rule:${key}:${normalized}`));
        const stamp = `${commit.work.id}:rule:${memoryId}`;
        const written = Effect.gen(function* () {
          const current = yield* store.loadAggregate(space, memoryId, { heads: true }, {});
          if (current.tombstone || current.pendingForget || current.heads.length > 1) return;
          if (!current.heads.length) {
            const payload = yield* decode(
              decodeSummaryPayload(
                {
                  text: M.MEMORY_RULE_PREFIX + body,
                  evidence,
                  // Independent of the thread's summary: forgetting that must not forget a rule.
                  derivedFromMemoryRevisions: [],
                },
                strict,
              ),
            );
            yield* deps.validateDependencies(space, payload);
            const operationId = M.MemoryOperationId.make(deps.stableUuid(`${stamp}:operation`));
            const revisionId = M.MemoryRevisionId.make(deps.stableUuid(`${stamp}:revision`));
            yield* apply(
              {
                protocolVersion: 1,
                kind: "upsert",
                memorySpaceId: space,
                memoryId,
                operationId,
                originEnvironmentId: environmentId,
                expectedHeads: [],
                payload,
                revision: {
                  memorySpaceId: space,
                  memoryId,
                  revisionId,
                  operationId,
                  parents: [],
                  scope,
                  payloadRef: revisionId,
                  assertionKind: "fact",
                  createdAtUtc: yield* now,
                  provenance: {
                    environmentId,
                    providerInstanceId: execution.providerInstanceId,
                    provider: execution.effectiveProvider,
                    requestedModelSelection: execution.requestedModelSelection,
                    effectiveModel: execution.effectiveModel,
                    sourceThread: thread,
                    sourceWatermark: batch.input.sourceWatermark,
                  },
                },
              },
              Store.localIntent,
              Effect.void,
            );
          }
          const old = rule.supersedes;
          if (!old || old === memoryId) return;
          const previous = yield* store.loadAggregate(space, old);
          const head = previous.revisions.find((p) => p.revision.revisionId === previous.heads[0]);
          if (
            previous.tombstone ||
            previous.pendingForget ||
            previous.heads.length !== 1 ||
            !head?.payload ||
            !M.isMemoryRule(head.payload.text) ||
            !previous.identity ||
            encodeScope(previous.identity.scope) !== encodeScope(scope)
          )
            return;
          yield* deps.forget({
            memorySpaceId: space,
            operationId: M.MemoryOperationId.make(
              deps.stableUuid(`${commit.work.id}:rule-forget:${old}`),
            ),
            memoryId: old,
            expectedHeads: previous.heads,
          });
        });
        // A refused rule rolls back alone, with the forget that would have replaced one.
        yield* deps.sql.withTransaction(written).pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(new Store.MemoryStorageError({ stage: "summary-rule", cause })),
            MemoryCapacityError: () => Effect.void,
            MemoryStoreConflict: () => Effect.void,
            MemoryAccessError: () => Effect.void,
          }),
        );
      }
    }
  });
  return Effect.fn("MemoryService.commitSummary")(function* (input: SummaryCommit) {
    const generated =
      input.generated === null ? null : yield* decode(decodeSummary(input.generated, strict));
    const work = input.work;
    if (work.metadata.kind !== "summary" || !work.memoryId)
      return yield* new Store.MemoryStoreConflict({ code: "unsupported_operation" });
    const meta = work.metadata;
    const memoryId = work.memoryId;
    if (
      generated &&
      (generated.execution.environmentId !== environmentId ||
        generated.execution.providerInstanceId !== meta.modelSelection.instanceId ||
        encodeSelection(generated.execution.requestedModelSelection) !==
          encodeSelection(meta.modelSelection))
    )
      return yield* new Store.MemoryStoreConflict({ code: "identity_mismatch" });
    if (generated && !M.validateMemoryGenerationResult(input.input, generated.result))
      return yield* invalid();
    if (generated && scanMemoryValue(generated.result).kind !== "allowed")
      return yield* new Store.MemoryStoreConflict({ code: "secret_detected" });
    const space = M.MemorySpaceId.make(work.space);
    return yield* store.transact(
      Effect.gen(function* () {
        const currentWork = yield* store.readWork(work.id);
        if (
          !currentWork ||
          currentWork.status !== "running" ||
          currentWork.claimedBy !== work.claimedBy ||
          currentWork.attempt !== work.attempt ||
          currentWork.claimedUntil !== work.claimedUntil ||
          work.claimedUntil === null ||
          work.claimedUntil <= (yield* Clock.currentTimeMillis)
        )
          return yield* new Store.MemoryStoreConflict({ code: "attempt_expired" });
        yield* input.recheckSource;
        const current = yield* store.loadAggregate(
          space,
          memoryId,
          generated ? {} : { heads: true },
          {},
        );
        if (current.tombstone || current.pendingForget)
          return yield* new Store.MemoryStoreConflict({ code: "forgotten" });
        if (encodeHeads(current.heads) !== encodeHeads(input.expectedHeads))
          return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
        const lineage = yield* store.readThreadLineage(meta.sourceThread, space);
        if (lineage.state !== "tracked")
          return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
        if (!generated) {
          // Nothing new to summarize, but promotions still hang off the standing summary.
          // Memories injected since it was written are in the thread's lineage, not in its payload.
          const head = current.revisions.find((p) => p.revision.revisionId === current.heads[0]);
          if (current.heads.length === 1 && head?.payload) {
            const dependencies = [
              ...new Set([...head.payload.derivedFromMemoryRevisions, ...lineage.revisions]),
            ];
            yield* promote(input, head.revision.revisionId, dependencies);
          }
          yield* commitRules(input);
          if (!(yield* store.completeSummaryWork(work)))
            return yield* new Store.MemoryStoreConflict({ code: "attempt_expired" });
          return undefined;
        }
        // The final input also carries lineage across in-memory generation chunks. Rebuilds
        // without the old summary must not inherit dependencies from the discarded head.
        const payload = yield* decode(
          decodeSummaryPayload(
            {
              text: M.stripMemoryRulePrefix(generated.result.text),
              evidence: generated.result.evidence,
              derivedFromMemoryRevisions: [
                ...new Set([
                  ...lineage.revisions,
                  ...(input.input.previousSummary?.derivedFromMemoryRevisions ?? []),
                ]),
              ],
            },
            strict,
          ),
        );
        yield* deps.validateDependencies(space, payload);
        const execution = generated.execution;
        const receipt = yield* apply(
          {
            protocolVersion: 1,
            kind: "upsert",
            memorySpaceId: space,
            memoryId,
            operationId: meta.operationId,
            originEnvironmentId: environmentId,
            expectedHeads: input.expectedHeads,
            payload,
            revision: {
              memorySpaceId: space,
              memoryId,
              revisionId: meta.revisionId,
              operationId: meta.operationId,
              parents: input.expectedHeads,
              scope: { kind: "thread", thread: meta.sourceThread },
              payloadRef: meta.revisionId,
              assertionKind: generated.result.assertionKind,
              createdAtUtc: yield* now,
              provenance: {
                environmentId,
                providerInstanceId: execution.providerInstanceId,
                provider: execution.effectiveProvider,
                requestedModelSelection: execution.requestedModelSelection,
                effectiveModel: execution.effectiveModel,
                sourceThread: meta.sourceThread,
                sourceWatermark: meta.sourceWatermark,
              },
            },
          },
          Store.localIntent,
          Effect.void,
        );
        yield* promote(input, meta.revisionId, payload.derivedFromMemoryRevisions);
        yield* commitRules(input);
        if (!(yield* store.completeSummaryWork(work)))
          return yield* new Store.MemoryStoreConflict({ code: "attempt_expired" });
        return receipt;
      }),
    );
  });
};
