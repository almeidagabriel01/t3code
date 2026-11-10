import {
  type Assistant,
  AssistantError,
  type AssistantId,
  type AssistantLibrary,
  type AssistantsCreateInput,
  type AssistantTask,
  type AssistantTeam,
  type AssistantTeamId,
  type AssistantTeamsCreateInput,
  type AssistantTeamsUpdateInput,
  assistantTeamProblem,
  type AssistantsEvent,
  type AssistantsResetInput,
  type AssistantScope,
  type AssistantsSetAvatarImageInput,
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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { listLibrary, removeOwnerTransfers } from "./AssistantTransfers.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as AssistantAvatars from "./AssistantAvatars.ts";
import * as AssistantConnectors from "./AssistantConnectors.ts";
import { AssistantTasks } from "./AssistantTasks.ts";
import {
  type AssistantTeamRow,
  allTeams,
  encodeMemberIds,
  encodeMemories,
  toAssistantTeam,
} from "./AssistantTeams.ts";
import {
  type AssistantRow,
  decodeMcpServers,
  encodeAutonomy,
  encodeAvatar,
  encodeBudget,
  encodeMcpServers,
  toAssistant,
  encodeProjectIds,
} from "./AssistantDirectory.ts";

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
    /** Every assistant, archived included; seeds Jarvis once and makes sure each active thread exists first. */
    readonly list: Effect.Effect<ReadonlyArray<Assistant>, AssistantError>;
    /** A snapshot, then one event per change. */
    readonly subscribe: Stream.Stream<AssistantsEvent, AssistantError>;
    /** Restores Jarvis: recreates or unarchives him and replaces a deleted conversation. */
    readonly ensureDefault: Effect.Effect<Assistant, AssistantError>;
    /** `options.id` makes a repeat idempotent: an assistant with that id already is the answer. */
    readonly create: (
      input: AssistantsCreateInput,
      options?: { readonly id?: string },
    ) => Effect.Effect<Assistant, AssistantError>;
    readonly update: (input: AssistantsUpdateInput) => Effect.Effect<Assistant, AssistantError>;
    /** Keeps its own copy of a finished avatar upload; clearing goes through `update { avatar: null }`. */
    readonly setAvatarImage: (
      input: AssistantsSetAvatarImageInput,
    ) => Effect.Effect<Assistant, AssistantError>;
    /** Hides a finished task from the lists; refused while its thread runs. A repeat changes nothing more. */
    readonly dismissTask: (threadId: ThreadId) => Effect.Effect<AssistantTask, AssistantError>;
    readonly restoreTask: (threadId: ThreadId) => Effect.Effect<AssistantTask, AssistantError>;
    readonly remove: (assistantId: AssistantId) => Effect.Effect<void, AssistantError>;
    readonly reset: (input: AssistantsResetInput) => Effect.Effect<Assistant, AssistantError>;
    readonly teams: Effect.Effect<ReadonlyArray<AssistantTeam>, AssistantError>;
    /** `options.id` makes a repeat idempotent: a group with that id already is the answer. */
    readonly createTeam: (
      input: AssistantTeamsCreateInput,
      options?: { readonly id?: string },
    ) => Effect.Effect<AssistantTeam, AssistantError>;
    readonly updateTeam: (
      input: AssistantTeamsUpdateInput,
    ) => Effect.Effect<AssistantTeam, AssistantError>;
    readonly removeTeam: (teamId: AssistantTeamId) => Effect.Effect<void, AssistantError>;
    /** Sends the team's current chat counters to clients only, not to `subscribeChanges`. */
    readonly refreshTeamChat: (teamId: string) => Effect.Effect<void>;
    /** Changes from now on, with no snapshot and no ensure, for services that react to them. */
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<AssistantsEvent>,
      never,
      Scope.Scope
    >;
    /** Files it handed over or received through the shared folder, newest first. */
    readonly library: (assistantId: AssistantId) => Effect.Effect<AssistantLibrary, AssistantError>;
    /** The model a new thread for this project starts on. */
    readonly defaultModel: (projectId: ProjectId) => Effect.Effect<ModelSelection, AssistantError>;
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
  const random = yield* SecureRandom.SecureRandom;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const connectors = yield* AssistantConnectors.AssistantConnectors;
  const tasks = yield* AssistantTasks;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const files = <A, E>(
    self: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig>,
  ) =>
    self.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, config),
    );
  const lock = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<AssistantsEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  // Chat counter updates reach clients but not services reacting to team changes, which would
  // reconcile the group on every message.
  const chatEvents = yield* PubSub.unbounded<AssistantsEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(chatEvents));

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

  const scopeFor = (projectId: string): Effect.Effect<AssistantScope> =>
    folders
      .isAssistantHomeProject(projectId as ProjectId)
      .pipe(Effect.map((home) => (home ? "all" : "project")));

  /** Rows from before scopes existed get theirs once; a project that cannot be read stays unset. */
  const backfillScopes = Effect.gen(function* () {
    const unset = yield* sql<{ readonly assistant_id: string; readonly project_id: string }>`
      SELECT assistant_id, project_id FROM assistants WHERE scope IS NULL`;
    for (const row of unset) {
      const scope = yield* scopeFor(row.project_id);
      yield* sql`UPDATE assistants SET scope = ${scope} WHERE assistant_id = ${row.assistant_id}`;
    }
  });

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
    const id = yield* random.uuidV4().pipe(Effect.orDie);
    yield* threads
      .dispatch(command(CommandId.make(`assistant-cmd:${id}`)))
      .pipe(Effect.catch(threadFailure("Could not update the assistant's conversation.")));
  });

  /** A muted line in the conversation; a failure to write it never fails the change it reports. */
  const noteInThread = Effect.fn("AssistantService.noteInThread")(function* (
    threadId: ThreadId,
    message: string,
  ) {
    const id = yield* random.uuidV4().pipe(Effect.orDie);
    yield* threads
      .dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make(`assistant-note:${id}`),
        threadId,
        message,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not leave a line in the assistant's conversation", { cause }),
        ),
      );
  });

  const archiveThread = (threadId: ThreadId, archived: boolean) =>
    dispatchThread((commandId) => ({
      type: archived ? "thread.archive" : "thread.unarchive",
      commandId,
      threadId,
    }));

  /**
   * Schedules belong to the assistant, so they follow it to whichever conversation is current.
   * Every other generation is a source, so a reset that failed midway heals on the next change.
   */
  const followSchedules = (
    row: { readonly assistant_id: string; readonly generation: number },
    to: ThreadId,
    projectId: string,
  ) =>
    scheduledTasks
      .retargetThreadTasks({
        fromThreadIds: Array.from({ length: row.generation }, (_, index) =>
          assistantThreadIdFor(row.assistant_id, index + 1),
        ).filter((threadId) => threadId !== to),
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

  const markSeeded = Effect.gen(function* () {
    yield* sql`
      INSERT OR IGNORE INTO assistant_seeds (assistant_id, seeded_at)
      VALUES (${DEFAULT_ASSISTANT_ID}, ${yield* nowIso})`;
  });

  /** Creates Jarvis if missing, unarchives him if archived, and makes sure he has a conversation. */
  const restoreDefaultRow = Effect.gen(function* () {
    const existing = yield* sql<{ readonly archived_at: string | null }>`
      SELECT archived_at FROM assistants WHERE assistant_id = ${DEFAULT_ASSISTANT_ID}`;
    if (existing.length === 0) {
      const project = yield* folders.ensureAssistantProject.pipe(
        Effect.catch(threadFailure("Could not create the project for assistants.")),
      );
      const now = yield* nowIso;
      yield* sql`
        INSERT OR IGNORE INTO assistants (
          assistant_id, handle, name, project_id, instructions, tool_access, is_default,
          generation, scope, created_at, updated_at
        ) VALUES (
          ${DEFAULT_ASSISTANT_ID}, ${DEFAULT_ASSISTANT_ID}, 'Jarvis', ${project.projectId},
          ${JARVIS_INSTRUCTIONS}, 'full', 1, 1, 'all', ${now}, ${now}
        )`;
    } else if (existing[0]!.archived_at !== null) {
      const row = yield* findRow(DEFAULT_ASSISTANT_ID);
      yield* sql`
        UPDATE assistants SET archived_at = NULL, updated_at = ${yield* nowIso}
        WHERE assistant_id = ${DEFAULT_ASSISTANT_ID}`;
      if (row.thread_id !== null) {
        const thread = yield* inspectThread(row.thread_id as ThreadId);
        if (thread !== undefined && thread.deletedAt === null) {
          yield* archiveThread(row.thread_id as ThreadId, false);
        }
      }
    }
    yield* markSeeded;
    yield* ensureLaunched(DEFAULT_ASSISTANT_ID);
    return yield* findRow(DEFAULT_ASSISTANT_ID);
  });

  /** Jarvis exists on first use only: a deleted or archived one stays that way until restored. */
  const seedDefault = Effect.gen(function* () {
    const seeded = yield* sql<{ readonly one: number }>`
      SELECT 1 AS one FROM assistant_seeds WHERE assistant_id = ${DEFAULT_ASSISTANT_ID}`;
    if (seeded.length === 0) yield* restoreDefaultRow;
  });

  const ensureAll = Effect.gen(function* () {
    yield* backfillScopes;
    yield* seedDefault;
    const active = (yield* allRows).filter((row) => row.archived_at === null);
    yield* Effect.forEach(
      active,
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
    .withPermits(1)(restoreDefaultRow.pipe(Effect.tap(() => publish(DEFAULT_ASSISTANT_ID))))
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
          const chatSubscription = yield* PubSub.subscribe(chatEvents);
          const assistants = (yield* allRows).map(toAssistant);
          const teams = yield* allTeams(sql);
          const taskSubscription = yield* PubSub.subscribe(tasks.changes);
          return Stream.concat(
            Stream.succeed<AssistantsEvent>({
              type: "snapshot",
              assistants,
              teams,
              tasks: yield* tasks.list,
            }),
            Stream.mergeAll(
              [
                Stream.fromSubscription(subscription),
                Stream.fromSubscription(chatSubscription),
                Stream.fromSubscription(taskSubscription).pipe(
                  Stream.map((task): AssistantsEvent => ({ type: "taskUpserted", task })),
                ),
              ],
              { concurrency: "unbounded" },
            ),
          );
        }),
      )
      .pipe(storage),
  );

  const setTaskDismissed = Effect.fn("AssistantService.setTaskDismissed")(function* (
    threadId: ThreadId,
    dismissed: boolean,
  ) {
    const current = yield* tasks.forThread(threadId);
    if (Option.isNone(current)) return yield* assistantError("not_found", "No such task.");
    if ((current.value.dismissedAt != null) === dismissed) return current.value;
    if (dismissed) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell !== null && shell.activeRunId !== null) {
        return yield* invalid("A running task cannot be dismissed. Stop it first.");
      }
    }
    const stored = yield* tasks.setDismissed(threadId, dismissed ? yield* nowIso : null);
    return Option.getOrElse(stored, () => current.value);
  });

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.orElseSucceed(Option.none),
      Effect.flatMap((project) =>
        Option.isSome(project) ? Effect.void : invalid("That project does not exist."),
      ),
    );

  /** The home project is the list's first; every project must exist. "all" if any is a home one. */
  const resolveProjects = Effect.fn("AssistantService.resolveProjects")(function* (
    projectIds: ReadonlyArray<ProjectId>,
  ) {
    yield* Effect.forEach(projectIds, requireProject);
    const scopes = yield* Effect.forEach(projectIds, scopeFor);
    return {
      scope: scopes.includes("all") ? ("all" as const) : ("project" as const),
      json: encodeProjectIds(projectIds),
    };
  });

  const allProjectsHome = folders.ensureAssistantProject.pipe(
    Effect.map((project) => project.projectId),
    Effect.catch(threadFailure("Could not create the project for assistants.")),
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
    function* (input, options) {
      if (input.restoreDefault === true) return yield* ensureDefault;
      const handle = input.handle ?? assistantHandleFromName(input.name);
      if (handle === null)
        return yield* invalid("Give the assistant a name with letters or digits.");
      const listed = [...new Set(input.projectIds ?? [])];
      const projectIds =
        input.scope === "all"
          ? [yield* allProjectsHome]
          : listed.length > 0
            ? listed
            : [input.projectId];
      const home = projectIds[0]!;
      const { scope, json: projectIdsJson } = yield* resolveProjects(projectIds);
      const id = options?.id ?? (yield* random.uuidV4().pipe(Effect.orDie));
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          // A repeat of a create that already landed is that assistant, not a second one.
          if (options?.id !== undefined) {
            const existing =
              yield* sql<AssistantRow>`SELECT * FROM assistants WHERE assistant_id = ${id}`;
            if (existing[0] !== undefined) return toAssistant(existing[0]);
          }
          yield* handleTaken(handle);
          const saved =
            input.mcpServers === undefined
              ? undefined
              : yield* connectors.save(id, [], input.mcpServers);
          const now = yield* nowIso;
          yield* sql`
            INSERT INTO assistants (
              assistant_id, handle, name, project_id, instructions, tool_access, is_default,
              generation, budget_json, autonomy_json, role, ask_before_acting,
              workspace, icon, avatar_json, scope, project_ids_json, mcp_servers_json, created_at, updated_at
            ) VALUES (
              ${id}, ${handle}, ${input.name}, ${home}, ${input.instructions},
              ${input.toolAccess}, 0, 1, ${input.budget ? encodeBudget(input.budget) : null},
              ${input.autonomy ? encodeAutonomy(input.autonomy) : null}, ${input.role?.trim() ?? ""},
              ${input.askBeforeActing === true ? 1 : 0}, ${input.workspace ?? "host"}, ${input.icon ?? null},
              ${input.avatar ? encodeAvatar(input.avatar) : null}, ${scope}, ${projectIdsJson},
              ${saved === undefined ? null : encodeMcpServers(saved.servers)}, ${now}, ${now}
            )`;
          const row = yield* findRow(id);
          const threadId = yield* launchGeneration(row, 1, input.modelSelection).pipe(
            // No conversation means nothing to show: take the row back so the handle is free again.
            Effect.tapError(() =>
              sql`DELETE FROM assistants WHERE assistant_id = ${id}`.pipe(
                Effect.andThen(
                  saved === undefined ? Effect.void : connectors.purge(id, saved.servers),
                ),
                Effect.ignore,
              ),
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
          if (input.handle !== undefined && input.handle !== row.handle) {
            yield* handleTaken(input.handle, row.assistant_id);
          }
          const listed = [...new Set(input.projectIds ?? [])];
          const requested =
            input.scope === "all"
              ? [
                  (yield* scopeFor(row.project_id)) === "all"
                    ? (row.project_id as ProjectId)
                    : yield* allProjectsHome,
                ]
              : listed.length > 0
                ? listed
                : input.projectId === undefined
                  ? undefined
                  : [input.projectId];
          // Adding projects keeps the home one, so it does not start a new conversation.
          const home =
            requested === undefined
              ? row.project_id
              : requested.includes(row.project_id as ProjectId)
                ? row.project_id
                : requested[0]!;
          const projectChanged = home !== row.project_id;
          const resolved = requested === undefined ? undefined : yield* resolveProjects(requested);
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
            projectId: home,
            budgetJson:
              input.budget === undefined
                ? row.budget_json
                : input.budget === null
                  ? null
                  : encodeBudget(input.budget),
            autonomyJson:
              input.autonomy === undefined ? row.autonomy_json : encodeAutonomy(input.autonomy),
            role: input.role?.trim() ?? row.role,
            askBeforeActing:
              input.askBeforeActing === undefined
                ? row.ask_before_acting
                : input.askBeforeActing
                  ? 1
                  : 0,
            workspace: input.workspace ?? row.workspace,
            icon: input.icon === undefined ? row.icon : input.icon,
            avatarJson:
              input.avatar === undefined
                ? row.avatar_json
                : input.avatar === null
                  ? null
                  : encodeAvatar(input.avatar),
            scope: resolved?.scope ?? row.scope,
            projectIdsJson: resolved?.json ?? row.project_ids_json ?? null,
          };
          const saved =
            input.mcpServers === undefined
              ? undefined
              : yield* connectors.save(
                  row.assistant_id,
                  decodeMcpServers(row.mcp_servers_json),
                  input.mcpServers,
                );
          const mcpServersJson =
            saved === undefined ? row.mcp_servers_json : encodeMcpServers(saved.servers);
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
                budget_json = ${next.budgetJson}, autonomy_json = ${next.autonomyJson},
                role = ${next.role},
                ask_before_acting = ${next.askBeforeActing}, workspace = ${next.workspace}, icon = ${next.icon}, avatar_json = ${next.avatarJson}, scope = ${next.scope}, project_ids_json = ${next.projectIdsJson}, mcp_servers_json = ${mcpServersJson}, archived_at = ${archivedAt}, updated_at = ${now}
              WHERE assistant_id = ${row.assistant_id}`;
            yield* followSchedules({ ...row, generation }, threadId, next.projectId);
            yield* retire(previousThreadId);
            if (archivedAt !== null) yield* archiveThread(threadId, true);
          } else {
            // The row is written first, so the thread guards already see the new access and state.
            yield* sql`
              UPDATE assistants SET name = ${next.name}, handle = ${next.handle},
                instructions = ${next.instructions}, tool_access = ${next.toolAccess},
                budget_json = ${next.budgetJson}, autonomy_json = ${next.autonomyJson},
                role = ${next.role},
                ask_before_acting = ${next.askBeforeActing}, workspace = ${next.workspace}, icon = ${next.icon}, avatar_json = ${next.avatarJson}, scope = ${next.scope}, project_ids_json = ${next.projectIdsJson}, mcp_servers_json = ${mcpServersJson}, archived_at = ${archivedAt}, updated_at = ${now}
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
                yield* noteInThread(previousThreadId, `Renamed to ${next.name}`);
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
          // Orphaned secret files are harmless; a failure here must not report the saved change as failed.
          if (saved !== undefined) {
            yield* saved.removeStale.pipe(
              Effect.catch((cause) =>
                Effect.logWarning("stale connector secrets were not deleted", { cause }),
              ),
            );
          }
          if (input.avatar !== undefined) {
            yield* files(AssistantAvatars.removeAvatarImages(row.assistant_id));
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

  const setAvatarImage: AssistantService["Service"]["setAvatarImage"] = Effect.fn(
    "AssistantService.setAvatarImage",
  )(function* (input) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* findRow(input.assistantId);
        yield* files(
          AssistantAvatars.storeAvatarImage({
            assistantId: row.assistant_id,
            attachmentId: input.attachmentId,
          }),
        );
        const now = yield* nowIso;
        yield* sql`
          UPDATE assistants SET avatar_json = ${encodeAvatar({ kind: "image", revision: Date.parse(now) })},
            updated_at = ${now}
          WHERE assistant_id = ${row.assistant_id}`;
        yield* publish(row.assistant_id);
        return toAssistant(yield* findRow(row.assistant_id));
      }),
    );
  }, storage);

  const findTeamRow = Effect.fn("AssistantService.findTeamRow")(function* (teamId: string) {
    const rows =
      yield* sql<AssistantTeamRow>`SELECT * FROM assistant_team_state WHERE team_id = ${teamId}`;
    return rows[0] ?? (yield* assistantError("not_found", "Team not found."));
  });

  /** Every member must exist; one archived assistant may stay in a team but not join it. */
  const checkTeam = Effect.fn("AssistantService.checkTeam")(function* (
    team: {
      readonly memberIds: ReadonlyArray<string>;
      readonly leadId: string | null;
    },
    kept: ReadonlyArray<string>,
  ) {
    const problem = assistantTeamProblem(team);
    if (problem !== null) return yield* invalid(problem);
    const all = yield* allRows;
    for (const memberId of team.memberIds) {
      const member = all.find((row) => row.assistant_id === memberId);
      if (member === undefined) return yield* invalid("A member of the team does not exist.");
      if (member.archived_at !== null && !kept.includes(memberId)) {
        return yield* invalid(`${member.name} is archived.`);
      }
    }
  });

  const createTeam: AssistantService["Service"]["createTeam"] = Effect.fn(
    "AssistantService.createTeam",
  )(function* (input, options) {
    const id = options?.id ?? (yield* random.uuidV4().pipe(Effect.orDie));
    const leadId = input.leadId ?? null;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // A repeat of a create that already landed is that group, not a second one.
        if (options?.id !== undefined) {
          const existing =
            yield* sql<AssistantTeamRow>`SELECT * FROM assistant_team_state WHERE team_id = ${id}`;
          if (existing[0] !== undefined) return toAssistantTeam(existing[0]);
        }
        yield* checkTeam({ memberIds: input.memberIds, leadId }, []);
        const now = yield* nowIso;
        yield* sql`
          INSERT INTO assistant_teams (
            team_id, name, member_ids_json, lead_id, created_at, updated_at
          ) VALUES (
            ${id}, ${input.name}, ${encodeMemberIds(input.memberIds)}, ${leadId},
            ${now}, ${now}
          )`;
        const team = toAssistantTeam(yield* findTeamRow(id));
        yield* PubSub.publish(events, { type: "teamUpserted", team });
        return team;
      }),
    );
  }, storage);

  const updateTeam: AssistantService["Service"]["updateTeam"] = Effect.fn(
    "AssistantService.updateTeam",
  )(function* (input) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* findTeamRow(input.teamId);
        const current = toAssistantTeam(row);
        const memberIds = input.memberIds ?? current.memberIds;
        // A lead that is dropped from the members goes with them, unless a new one is sent.
        const leadId =
          input.leadId !== undefined
            ? input.leadId
            : current.leadId !== null && memberIds.includes(current.leadId)
              ? current.leadId
              : null;
        yield* checkTeam({ memberIds, leadId }, current.memberIds);
        const archivedAt =
          input.archived === undefined
            ? current.archivedAt
            : input.archived
              ? (current.archivedAt ?? (yield* nowIso))
              : null;
        yield* sql`
          UPDATE assistant_teams SET name = ${input.name ?? current.name},
            member_ids_json = ${encodeMemberIds(memberIds)}, lead_id = ${leadId},
            archived_at = ${archivedAt},
            instructions = ${input.instructions?.trim() ?? current.instructions ?? ""},
            memories_json = ${encodeMemories(input.memories ?? current.memories ?? [])},
            updated_at = ${yield* nowIso}
          WHERE team_id = ${input.teamId}`;
        const team = toAssistantTeam(yield* findTeamRow(input.teamId));
        yield* PubSub.publish(events, { type: "teamUpserted", team });
        return team;
      }),
    );
  }, storage);

  const removeTeam: AssistantService["Service"]["removeTeam"] = Effect.fn(
    "AssistantService.removeTeam",
  )(function* (teamId) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* findTeamRow(teamId);
        yield* sql`DELETE FROM assistant_teams WHERE team_id = ${teamId}`;
        yield* PubSub.publish(events, { type: "teamRemoved", teamId });
      }),
    );
  }, storage);

  const refreshTeamChat: AssistantService["Service"]["refreshTeamChat"] = (teamId) =>
    sql<AssistantTeamRow>`SELECT * FROM assistant_team_state WHERE team_id = ${teamId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.void
          : PubSub.publish(chatEvents, { type: "teamUpserted", team: toAssistantTeam(rows[0]) }),
      ),
      Effect.ignore,
    );

  const teams: AssistantService["Service"]["teams"] = allTeams(sql).pipe(storage);

  /** A deleted assistant leaves its teams; a group may be left empty or with one member. */
  const leaveTeams = Effect.fn("AssistantService.leaveTeams")(function* (assistantId: string) {
    for (const team of yield* allTeams(sql)) {
      if (!team.memberIds.includes(assistantId as never)) continue;
      const memberIds = team.memberIds.filter((id) => id !== assistantId);
      const leadId = team.leadId === assistantId ? null : team.leadId;
      yield* sql`
        UPDATE assistant_teams SET member_ids_json = ${encodeMemberIds(memberIds)},
          lead_id = ${leadId}, updated_at = ${yield* nowIso}
        WHERE team_id = ${team.id}`;
      yield* PubSub.publish(events, {
        type: "teamUpserted",
        team: toAssistantTeam(yield* findTeamRow(team.id)),
      });
    }
  });

  const threadIdsOf = (assistantId: string, generation: number) =>
    Array.from({ length: generation }, (_, index) => assistantThreadIdFor(assistantId, index + 1));

  const remove: AssistantService["Service"]["remove"] = Effect.fn("AssistantService.remove")(
    function* (assistantId) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* findRow(assistantId);
          // The row goes first: the thread guards only protect a live assistant's conversation.
          yield* sql`DELETE FROM assistants WHERE assistant_id = ${assistantId}`;
          yield* leaveTeams(assistantId);
          yield* files(AssistantAvatars.removeAvatarImages(assistantId));
          // Its transfers and the requests it was waiting on go with it; the rest of `shared/` stays.
          yield* removeOwnerTransfers(config.sharedDir, assistantId);
          yield* sql`DELETE FROM assistant_requests WHERE sender_thread_id LIKE ${`assistant:${assistantId}:%`}`;
          yield* tasks.removeFor(assistantId);
          yield* connectors
            .purge(assistantId, decodeMcpServers(row.mcp_servers_json))
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("connector secrets were not deleted", { cause }),
              ),
            );
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
                scope = ${yield* scopeFor(thread.projectId)},
                project_ids_json = CASE
                  WHEN EXISTS (SELECT 1 FROM json_each(project_ids_json) WHERE value = ${thread.projectId})
                  THEN project_ids_json ELSE json_array(${thread.projectId}) END,
                updated_at = ${yield* nowIso}
              WHERE assistant_id = ${row.assistant_id}`;
            yield* followSchedules(row, restore, thread.projectId);
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
            yield* followSchedules({ ...row, generation }, threadId, row.project_id);
            yield* retire(previousThreadId);
          }
          yield* publish(row.assistant_id);
          return toAssistant(yield* findRow(row.assistant_id));
        }),
      );
    },
    storage,
  );

  const library: AssistantService["Service"]["library"] = Effect.fn("AssistantService.library")(
    function* (assistantId) {
      const row = yield* findRow(assistantId);
      return yield* listLibrary(config.sharedDir, row.assistant_id);
    },
    storage,
  );

  return AssistantService.of({
    library,
    list,
    subscribe,
    ensureDefault,
    create,
    update,
    setAvatarImage,
    dismissTask: Effect.fn("AssistantService.dismissTask")((threadId) =>
      setTaskDismissed(threadId, true),
    ),
    restoreTask: Effect.fn("AssistantService.restoreTask")((threadId) =>
      setTaskDismissed(threadId, false),
    ),
    remove,
    reset,
    teams,
    createTeam,
    updateTeam,
    removeTeam,
    refreshTeamChat,
    subscribeChanges: PubSub.subscribe(events),
    defaultModel: defaultModelSelection,
  });
});

export const layer = Layer.effect(AssistantService, make);
