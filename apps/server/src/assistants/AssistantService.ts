import {
  type Assistant,
  AssistantError,
  type AssistantId,
  type AssistantsCreateInput,
  type AssistantsEvent,
  type AssistantsResetInput,
  type AssistantsUpdateInput,
  assistantHandleFromName,
  assistantIdFromThreadId,
  assistantThreadIdFor,
  CommandId,
  DEFAULT_ASSISTANT_ID,
  DEFAULT_MODEL,
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  runtimeModeForToolAccess,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { type AssistantRow, encodeBudget, toAssistant } from "./AssistantDirectory.ts";

const JARVIS_INSTRUCTIONS = [
  "You are Jarvis, the user's general assistant across all of their projects.",
  "Answer directly when you can: read files, notes and memory, and look things up.",
  "When the work changes code in a repository, do not do it in this conversation. Launch a thread in that project (t3_thread_launch with a worktree) or hand it off with delegate_task, then report back here what happened.",
  "Use the memory tools to remember what the user tells you to keep, and to recall it before you ask again.",
  "When the user should own a choice, file it with t3_decision instead of guessing.",
].join("\n");

const assistantError = (reason: AssistantError["reason"], message: string) =>
  new AssistantError({ reason, message });
const invalid = (message: string) => Effect.fail(assistantError("invalid", message));

/** Thread work after a row change: logged with its cause, shown as one storage failure. */
const threadFailure = (message: string) => (cause: unknown) =>
  Effect.logWarning(message, { cause }).pipe(
    Effect.andThen(Effect.fail(assistantError("storage", message))),
  );

export class AssistantService extends Context.Service<
  AssistantService,
  {
    /** Every assistant, archived included; makes sure Jarvis and each active thread exist first. */
    readonly list: Effect.Effect<ReadonlyArray<Assistant>, AssistantError>;
    /** A snapshot, then one event per change. */
    readonly subscribe: Stream.Stream<AssistantsEvent, AssistantError>;
    /** Idempotent: creates Jarvis and his conversation once, and replaces a deleted conversation. */
    readonly ensureDefault: Effect.Effect<Assistant, AssistantError>;
    readonly create: (input: AssistantsCreateInput) => Effect.Effect<Assistant, AssistantError>;
    readonly update: (input: AssistantsUpdateInput) => Effect.Effect<Assistant, AssistantError>;
    readonly remove: (assistantId: AssistantId) => Effect.Effect<void, AssistantError>;
    readonly reset: (input: AssistantsResetInput) => Effect.Effect<Assistant, AssistantError>;
  }
>()("t3/assistants/AssistantService") {}

/** Like a new thread with no configured default: the first usable provider and its default model. */
export function firstUsableProviderModel(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const provider = providers.find(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.auth.status !== "unauthenticated" &&
      isProviderAvailable(entry),
  );
  if (provider === undefined) return null;
  const model =
    provider.models.find((entry) => entry.isDefault && !entry.isCustom) ??
    provider.models.find((entry) => !entry.isCustom) ??
    provider.models[0];
  return model === undefined ? null : { instanceId: provider.instanceId, model: model.slug };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const lock = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<AssistantsEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storage = <A, R>(self: Effect.Effect<A, SqlError | AssistantError, R>) =>
    self.pipe(
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.logWarning("assistants storage failed", { cause }).pipe(
            Effect.andThen(
              Effect.fail(assistantError("storage", "Could not read or write assistants.")),
            ),
          ),
      }),
    );

  const findRow = Effect.fn("AssistantService.findRow")(function* (assistantId: string) {
    const rows =
      yield* sql<AssistantRow>`SELECT * FROM assistants WHERE assistant_id = ${assistantId}`;
    return rows[0] ?? (yield* assistantError("not_found", "Assistant not found."));
  });

  const publish = (assistantId: string) =>
    findRow(assistantId).pipe(
      Effect.flatMap((row) =>
        PubSub.publish(events, { type: "upserted", assistant: toAssistant(row) }),
      ),
    );

  const allRows = sql<AssistantRow>`SELECT * FROM assistants ORDER BY is_default DESC, created_at ASC`;

  /** A thread the server cannot read keeps its state: only a deletion we saw replaces it. */
  const inspectThread = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }) => thread),
      Effect.orElseSucceed(() => undefined),
    );

  const defaultModelSelection = Effect.fn("AssistantService.defaultModelSelection")(function* (
    projectId: ProjectId,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => assistantError("storage", "Could not read the server settings.")),
    );
    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    const configured = resolveProjectSettings(settings, projectId, Option.getOrNull(project))
      .settings.defaultModelSelection;
    if (configured) return configured;
    const providers = Option.isSome(providerRegistry)
      ? yield* providerRegistry.value.getProviders
      : [];
    // ponytail: no usage-limit fallback chain here, the user picks the model on the thread.
    return (
      firstUsableProviderModel(providers) ??
      ({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      } satisfies ModelSelection)
    );
  });

  /** Ids derive from (assistant, generation), so a repeat after a crash lands on the same thread. */
  const launchGeneration = Effect.fn("AssistantService.launchGeneration")(function* (
    row: AssistantRow,
    generation: number,
    modelSelection: ModelSelection | undefined,
  ) {
    const projectId = row.project_id as ProjectId;
    const launched = yield* launches
      .launch({
        commandId: CommandId.make(`assistant-launch:${row.assistant_id}:${generation}`),
        threadId: assistantThreadIdFor(row.assistant_id, generation),
        projectId,
        title: row.name,
        generateTitle: false,
        modelSelection: modelSelection ?? (yield* defaultModelSelection(projectId)),
        runtimeMode: runtimeModeForToolAccess(toAssistant(row).toolAccess),
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.catch(threadFailure("Could not start the assistant's conversation.")));
    return launched.threadId;
  });

  const dispatchThread = Effect.fn("AssistantService.dispatchThread")(function* (
    command: (commandId: CommandId) => Parameters<typeof threads.dispatch>[0],
  ) {
    const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    yield* threads
      .dispatch(command(CommandId.make(`assistant-cmd:${id}`)))
      .pipe(Effect.catch(threadFailure("Could not update the assistant's conversation.")));
  });

  const archiveThread = (threadId: ThreadId, archived: boolean) =>
    dispatchThread((commandId) => ({
      type: archived ? "thread.archive" : "thread.unarchive",
      commandId,
      threadId,
    }));

  /** Schedules belong to the assistant, so they follow it to whichever conversation is current. */
  const followSchedules = (from: string | null, to: ThreadId, projectId: string) =>
    from === null || from === to
      ? Effect.void
      : scheduledTasks
          .retargetThreadTasks({
            fromThreadId: from as ThreadId,
            toThreadId: to,
            projectId: projectId as ProjectId,
          })
          .pipe(Effect.catch(threadFailure("Could not move the assistant's schedules.")));

  /** Archives a conversation that was already replaced, if it is still live. */
  const retire = (threadId: string | null) =>
    threadId === null
      ? Effect.void
      : inspectThread(threadId as ThreadId).pipe(
          Effect.flatMap((thread) =>
            thread === undefined || thread.deletedAt !== null || thread.archivedAt !== null
              ? Effect.void
              : archiveThread(threadId as ThreadId, true),
          ),
        );

  /** Starts a conversation when the row has none, or the one it had was deleted. */
  const ensureLaunched = Effect.fn("AssistantService.ensureLaunched")(function* (
    assistantId: string,
  ) {
    const row = yield* findRow(assistantId);
    if (row.archived_at !== null) return;
    if (row.thread_id !== null) {
      const thread = yield* inspectThread(row.thread_id as ThreadId);
      if (thread === undefined || thread.deletedAt === null) return;
    }
    const generation = row.thread_id === null ? row.generation : row.generation + 1;
    const threadId = yield* launchGeneration(row, generation, undefined);
    yield* sql`
      UPDATE assistants SET thread_id = ${threadId}, generation = ${generation}, updated_at = ${yield* nowIso}
      WHERE assistant_id = ${assistantId} AND thread_id IS ${row.thread_id}`;
    yield* publish(assistantId);
  });

  const ensureDefaultRow = Effect.gen(function* () {
    const existing = yield* sql<{ readonly one: number }>`
      SELECT 1 AS one FROM assistants WHERE assistant_id = ${DEFAULT_ASSISTANT_ID}`;
    if (existing.length === 0) {
      const project = yield* folders.ensureAssistantProject.pipe(
        Effect.catch(threadFailure("Could not create the project for assistants.")),
      );
      const now = yield* nowIso;
      yield* sql`
        INSERT OR IGNORE INTO assistants (
          assistant_id, handle, name, project_id, instructions, tool_access, is_default,
          generation, created_at, updated_at
        ) VALUES (
          ${DEFAULT_ASSISTANT_ID}, ${DEFAULT_ASSISTANT_ID}, 'Jarvis', ${project.projectId},
          ${JARVIS_INSTRUCTIONS}, 'full', 1, 1, ${now}, ${now}
        )`;
    }
    yield* ensureLaunched(DEFAULT_ASSISTANT_ID);
    return yield* findRow(DEFAULT_ASSISTANT_ID);
  });

  /** Jarvis first, so a broken assistant never keeps the others from loading. */
  const ensureAll = Effect.gen(function* () {
    yield* ensureDefaultRow;
    const others = (yield* allRows).filter(
      (row) => row.assistant_id !== DEFAULT_ASSISTANT_ID && row.archived_at === null,
    );
    yield* Effect.forEach(
      others,
      (row) =>
        ensureLaunched(row.assistant_id).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("assistant conversation skipped", {
              assistantId: row.assistant_id,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const ensureQuietly = ensureAll.pipe(
    Effect.catch((cause) => Effect.logWarning("assistants ensure failed", { cause })),
  );

  const ensureDefault: AssistantService["Service"]["ensureDefault"] = lock
    .withPermits(1)(ensureDefaultRow)
    .pipe(Effect.map(toAssistant), storage, Effect.withSpan("AssistantService.ensureDefault"));

  const list: AssistantService["Service"]["list"] = lock
    .withPermits(1)(ensureQuietly.pipe(Effect.andThen(allRows)))
    .pipe(
      Effect.map((rows) => rows.map(toAssistant)),
      storage,
      Effect.withSpan("AssistantService.list"),
    );

  const subscribe: AssistantService["Service"]["subscribe"] = Stream.unwrap(
    // Subscribe before the snapshot while holding the writers' lock, so no change falls between.
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* ensureQuietly;
          const subscription = yield* PubSub.subscribe(events);
          const assistants = (yield* allRows).map(toAssistant);
          return Stream.concat(
            Stream.succeed<AssistantsEvent>({ type: "snapshot", assistants }),
            Stream.fromSubscription(subscription),
          );
        }),
      )
      .pipe(storage),
  );

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.orElseSucceed(Option.none),
      Effect.flatMap((project) =>
        Option.isSome(project) ? Effect.void : invalid("That project does not exist."),
      ),
    );

  const handleTaken = (handle: string, exceptId?: string) =>
    sql<{ readonly one: number }>`
      SELECT 1 AS one FROM assistants WHERE handle = ${handle} AND assistant_id <> ${exceptId ?? ""}`.pipe(
      Effect.flatMap((rows) =>
        rows.length > 0
          ? Effect.fail(
              assistantError("handle_taken", "Another assistant already uses that handle."),
            )
          : Effect.void,
      ),
    );

  const create: AssistantService["Service"]["create"] = Effect.fn("AssistantService.create")(
    function* (input) {
      const handle = input.handle ?? assistantHandleFromName(input.name);
      if (handle === null)
        return yield* invalid("Give the assistant a name with letters or digits.");
      yield* requireProject(input.projectId);
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* handleTaken(handle);
          const now = yield* nowIso;
          yield* sql`
            INSERT INTO assistants (
              assistant_id, handle, name, project_id, instructions, tool_access, is_default,
              generation, budget_json, created_at, updated_at
            ) VALUES (
              ${id}, ${handle}, ${input.name}, ${input.projectId}, ${input.instructions},
              ${input.toolAccess}, 0, 1, ${input.budget ? encodeBudget(input.budget) : null},
              ${now}, ${now}
            )`;
          const row = yield* findRow(id);
          const threadId = yield* launchGeneration(row, 1, input.modelSelection).pipe(
            // No conversation means nothing to show: take the row back so the handle is free again.
            Effect.tapError(() =>
              sql`DELETE FROM assistants WHERE assistant_id = ${id}`.pipe(Effect.ignore),
            ),
          );
          yield* sql`UPDATE assistants SET thread_id = ${threadId} WHERE assistant_id = ${id}`;
          yield* publish(id);
          return toAssistant(yield* findRow(id));
        }),
      );
    },
    storage,
  );

  const update: AssistantService["Service"]["update"] = Effect.fn("AssistantService.update")(
    function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          let row = yield* findRow(input.assistantId);
          if (input.archived === true && row.is_default === 1) {
            return yield* assistantError("default_protected", "Jarvis can't be archived.");
          }
          if (input.handle !== undefined && input.handle !== row.handle) {
            yield* handleTaken(input.handle, row.assistant_id);
          }
          const projectChanged =
            input.projectId !== undefined && input.projectId !== row.project_id;
          if (input.projectId !== undefined && projectChanged)
            yield* requireProject(input.projectId);
          // A deleted conversation is replaced first, so the changes below land on a live one.
          yield* ensureLaunched(row.assistant_id);
          row = yield* findRow(row.assistant_id);
          const previousThreadId = row.thread_id as ThreadId | null;
          const previous =
            previousThreadId === null ? undefined : yield* inspectThread(previousThreadId);
          const archivedAt =
            input.archived === undefined
              ? row.archived_at
              : input.archived
                ? (row.archived_at ?? (yield* nowIso))
                : null;
          const next = {
            name: input.name ?? row.name,
            handle: input.handle ?? row.handle,
            instructions: input.instructions ?? row.instructions,
            toolAccess: input.toolAccess ?? toAssistant(row).toolAccess,
            projectId: input.projectId ?? row.project_id,
            budgetJson:
              input.budget === undefined
                ? row.budget_json
                : input.budget === null
                  ? null
                  : encodeBudget(input.budget),
          };
          const now = yield* nowIso;
          if (projectChanged) {
            // A thread can't change projects: the new project gets the next generation.
            const generation = row.generation + 1;
            const threadId = yield* launchGeneration(
              {
                ...row,
                name: next.name,
                tool_access: next.toolAccess,
                project_id: next.projectId,
              },
              generation,
              input.modelSelection ?? previous?.modelSelection,
            );
            yield* sql`
              UPDATE assistants SET name = ${next.name}, handle = ${next.handle},
                instructions = ${next.instructions}, tool_access = ${next.toolAccess},
                project_id = ${next.projectId}, thread_id = ${threadId}, generation = ${generation},
                budget_json = ${next.budgetJson}, archived_at = ${archivedAt}, updated_at = ${now}
              WHERE assistant_id = ${row.assistant_id}`;
            yield* followSchedules(previousThreadId, threadId, next.projectId);
            yield* retire(previousThreadId);
            if (archivedAt !== null) yield* archiveThread(threadId, true);
          } else {
            // The row is written first, so the thread guards already see the new access and state.
            yield* sql`
              UPDATE assistants SET name = ${next.name}, handle = ${next.handle},
                instructions = ${next.instructions}, tool_access = ${next.toolAccess},
                budget_json = ${next.budgetJson}, archived_at = ${archivedAt}, updated_at = ${now}
              WHERE assistant_id = ${row.assistant_id}`;
            if (
              previousThreadId !== null &&
              previous !== undefined &&
              previous.deletedAt === null
            ) {
              if (next.name !== row.name) {
                yield* dispatchThread((commandId) => ({
                  type: "thread.metadata.update",
                  commandId,
                  threadId: previousThreadId,
                  title: next.name,
                }));
              }
              if (input.modelSelection !== undefined) {
                const modelSelection = input.modelSelection;
                yield* dispatchThread((commandId) => ({
                  type: "thread.model-selection.set",
                  commandId,
                  threadId: previousThreadId,
                  modelSelection,
                }));
              }
              if (next.toolAccess !== row.tool_access) {
                yield* dispatchThread((commandId) => ({
                  type: "thread.runtime-mode.set",
                  commandId,
                  threadId: previousThreadId,
                  runtimeMode: runtimeModeForToolAccess(next.toolAccess),
                }));
              }
              if (archivedAt !== null && row.archived_at === null) {
                yield* archiveThread(previousThreadId, true);
              } else if (archivedAt === null && row.archived_at !== null) {
                yield* archiveThread(previousThreadId, false);
              }
            }
          }
          yield* publish(row.assistant_id);
          if (archivedAt === null && row.archived_at !== null) {
            // Unarchiving a row whose conversation was deleted while archived.
            yield* ensureLaunched(row.assistant_id);
            yield* publish(row.assistant_id);
          }
          return toAssistant(yield* findRow(row.assistant_id));
        }),
      );
    },
    storage,
  );

  const threadIdsOf = (assistantId: string, generation: number) =>
    Array.from({ length: generation }, (_, index) => assistantThreadIdFor(assistantId, index + 1));

  const remove: AssistantService["Service"]["remove"] = Effect.fn("AssistantService.remove")(
    function* (assistantId) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* findRow(assistantId);
          if (row.is_default === 1) {
            return yield* assistantError("default_protected", "Jarvis can't be deleted.");
          }
          // The row goes first: the thread guards only protect a live assistant's conversation.
          yield* sql`DELETE FROM assistants WHERE assistant_id = ${assistantId}`;
          yield* PubSub.publish(events, {
            type: "removed",
            assistantId: row.assistant_id as AssistantId,
          });
          yield* Effect.forEach(
            threadIdsOf(row.assistant_id, row.generation),
            (threadId) =>
              inspectThread(threadId).pipe(
                Effect.flatMap((thread) =>
                  thread === undefined || thread.deletedAt !== null
                    ? Effect.void
                    : dispatchThread((commandId) => ({
                        type: "thread.delete",
                        commandId,
                        threadId,
                      })),
                ),
                // One stuck conversation never keeps the rest from being deleted.
                Effect.catch((cause) =>
                  Effect.logWarning("assistant conversation was not deleted", { threadId, cause }),
                ),
                // Thread deletion cleans schedules too; this covers a conversation that never deleted.
                Effect.andThen(
                  scheduledTasks.deleteForThread(threadId).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("assistant schedules were not deleted", {
                        threadId,
                        cause,
                      }),
                    ),
                  ),
                ),
              ),
            { discard: true },
          );
        }),
      );
    },
    storage,
  );

  const reset: AssistantService["Service"]["reset"] = Effect.fn("AssistantService.reset")(
    function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* findRow(input.assistantId);
          if (row.archived_at !== null) {
            return yield* invalid("Unarchive the assistant before starting a new conversation.");
          }
          const previousThreadId = row.thread_id as ThreadId | null;
          if (input.restoreThreadId !== undefined) {
            const restore = input.restoreThreadId;
            if (assistantIdFromThreadId(restore) !== row.assistant_id) {
              return yield* invalid("That conversation belongs to another assistant.");
            }
            if (restore === previousThreadId) return toAssistant(row);
            const thread = yield* inspectThread(restore);
            if (thread === undefined || thread.deletedAt !== null) {
              return yield* assistantError("not_found", "That conversation no longer exists.");
            }
            // The pointer moves before the thread comes back, so it is already the current one.
            // A thread can't change projects, so the assistant follows it to the restored one's.
            yield* sql`
              UPDATE assistants SET thread_id = ${restore}, project_id = ${thread.projectId},
                updated_at = ${yield* nowIso}
              WHERE assistant_id = ${row.assistant_id}`;
            yield* followSchedules(previousThreadId, restore, thread.projectId);
            if (thread.archivedAt !== null) yield* archiveThread(restore, false);
            yield* retire(previousThreadId);
          } else {
            const previous =
              previousThreadId === null ? undefined : yield* inspectThread(previousThreadId);
            const generation = row.generation + 1;
            const threadId = yield* launchGeneration(row, generation, previous?.modelSelection);
            yield* sql`
              UPDATE assistants SET thread_id = ${threadId}, generation = ${generation}, updated_at = ${yield* nowIso}
              WHERE assistant_id = ${row.assistant_id}`;
            yield* followSchedules(previousThreadId, threadId, row.project_id);
            yield* retire(previousThreadId);
          }
          yield* publish(row.assistant_id);
          return toAssistant(yield* findRow(row.assistant_id));
        }),
      );
    },
    storage,
  );

  return AssistantService.of({ list, subscribe, ensureDefault, create, update, remove, reset });
});

export const layer = Layer.effect(AssistantService, make);
