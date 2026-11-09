# Assistants

An assistant is a row (`assistants` table, `AssistantService`) that points at a real thread. Nothing
else about the conversation is special: it runs through the same orchestrator, providers and
projections as any thread.

## Identity is the thread id

An assistant thread's id is `assistant:<assistantId>:<generation>`. `AssistantDirectory.forThread`
answers from that prefix and returns without a query for every other thread, so the hot paths that ask
(turn start, runtime policy, dispatch) cost nothing for ordinary threads. Do not add a column or flag
to threads to mark them.

## Generations

A reset, or a project change, launches the next generation and moves the row's pointer before the old
thread is archived, so a crash leaves two threads and a valid pointer, never none. Launch ids derive
from (assistant, generation), which makes a retry land on the same thread. Old generations are
ordinary archived threads that "restore" can bring back.

Scheduled tasks bind to a thread id, so every pointer move retargets the tasks of all other
generations onto the current thread. Moving from every generation, not just the previous one, lets a
change that failed midway heal on the next.

## Approvals become decisions

`AssistantApprovalReactor` mirrors each pending live approval on an assistant thread into a decision
with `approvalRequestId` set, and withdraws it silently when the request resolves anywhere else.
`DecisionService` answers such a decision with `runtime-request.respond` instead of a message, and a
dismiss or expiry declines: a dismissed approval must never leave the turn blocked. Clients hide these
decisions on their own thread, where the native approval prompt already shows.

## Four enforcement points

Tool access is the runtime mode plus, for read only, a read-only sandbox. Both are enforced
server-side so no client or agent can skip them:

1. `AssistantRuntimePolicy` wraps `RuntimePolicyV2` and applies the sandbox on every turn start, so an
   access change takes effect on the next turn without touching the thread.
2. `ThreadManagementService.dispatch` refuses commands that would defeat the assistant: raising the
   runtime mode above its access, archiving or deleting the current thread, unarchiving an old
   generation, and a `titleSeed` renaming the thread. It covers WebSocket and MCP callers alike.
3. Assistants may message each other freely, without a send cap, so `dispatch` only checks what a
   send reaches. `senderThreadId` rides on every agent send (MCP
   `t3_thread_send` sets it), so the guard needs no new plumbing. A send into a non-assistant
   thread still goes through the sandbox and project-scope refusals and, for "Ask before acting",
   the approval below.

4. "Ask before acting": the same `dispatch` holds a `message.dispatch` from an assistant with the flag
   into any non-assistant thread until the user approves that exact send. The approval is a decision
   in the assistant's own conversation keyed by (assistant, target, text hash, attempt). An approval
   is consumed by the first send that claims it (`claimExecution`) and a failed send gives it back;
   a denial or dismissal keeps refusing that exact text, and an expired ask is asked again.
   `DecisionService` depends on `ThreadManagementService`, so the guard reads a
   late-bound `AskBeforeActingGate` that `AskBeforeActing.installLayer` fills; with none installed a
   flagged assistant cannot send at all.

`AssistantService` dispatches through the Orchestrator directly, not `ThreadManagementService`, so its
own archive, delete and unarchive pass the guard. Keep it that way.

All read the directory with `Effect.serviceOption`, so layers that don't provide it behave as before.
A runtime layer that forgets to provide it silently loses enforcement; `runtimeLayer.ts` must wire it.

## Project scope and avatars

`assistants.scope` is `project` when the assistant's project is not Scratch or the managed
`assistants` project (`ManagedProjectFolders.isAssistantHomeProject`). It is stored, not derived,
because `toAssistant` and `AssistantDirectory` are synchronous and layer-light; rows from before it
existed are filled on the first list or subscribe, and count as `all` until then.
`projectId` is the home project, where the conversation lives and a thread cannot move; a project
assistant also has `project_ids_json`, the list of projects it may work in, home first (read as just the
home when null). Adding projects keeps the home, so it starts no new generation; dropping the home does.
`projectScopeRefusal` is the one allow check and mirrors `sandboxRefusal` at the same sites
(`t3_thread_launch`, remote `delegate_task`, scheduled tasks, and `message.dispatch` to a non-assistant
thread): the target project must be on the list. New paths call it rather than comparing project ids.

An image avatar is copied from the finished upload into `<stateDir>/assistant-avatars/` after a magic
byte check: pending uploads are swept after a while, so the upload itself cannot be the avatar. It is
served through the signed `assistant-avatar` asset resource.

## Teams

An `assistant_teams` row holds members (a JSON array of assistant ids) and an optional lead. The
lead is one of the members and only routes a group chat message that mentions nobody; it never
changes who may message whom. `AssistantService` owns team CRUD and publishes `teamUpserted`
and `teamRemoved` on the assistants stream (the snapshot carries `teams`), so one subscription feeds
every client. A group may hold any number of members, none included, so one can be made from the
sidebar before anyone joins it. Deleting an assistant, or removing it from the members, clears the
lead when it was that member; archiving leaves membership alone. `ensureForkSchema` renames the old
`leader_id` column to `lead_id` and drops `leader_title` and `assistants.reports_to`.

## Group chat (an OpenBot channel)

`AssistantGroups` owns a group's chat (`assistant_group_messages`, seq per group) and its tasks
(`assistant_group_tasks`). A chat message runs nothing itself: it opens one root task per recipient,
and each member works its tasks in its own hidden thread for that group,
`assistant:<assistantId>:g-<hash>` (`assistant_group_threads`). The suffix is a hash because team ids
may hold `:`; look the group up in the table, never parse it out of the id. `forThread` resolves these
threads as non-current, so sandbox, runtime policy, connectors and the note apply, and
`guardAssistantThread` refuses archive, delete and unarchive on them; the service changes their
lifecycle through the Orchestrator directly.

Recipients are decided before any model, first match winning (`routeGroupMessage`): the `@` mentions
anywhere in the text (`assistantGroupMentions`, the one parser the clients highlight and preview
with), a reply to a member message, a user's bare "continue" (resumes the newest stopped root task),
a user's follow-up while exactly one task is open (its owner), then a group of one. Only then does the
lead route, through the optional `routeAssistantGroup` text-generation op (Claude, Codex,
Antigravity), which may answer `noReply` for a thanks: no task, a muted `change` line that also marks
the message as handled. With no lead a message is stored and left pending (clients show it as waiting,
derived from "no task and no note"); `routePending` routes it when a team change sets one and on
start. A lead whose provider cannot route still refuses with `mention_required` before anything is
stored. Agents and schedules skip the continue and follow-up rules: they are not the user answering
what is on screen.

A member's task packet (`AssistantGroupPacket`) holds the chat since its last task, a rolling summary
of the earlier chat, and older messages the instruction names (`#seq`) or replies to; `t3_group history`
covers the rest. The summary lives in `assistant_group_summaries`, is refreshed in the background by
`summarizeAssistantGroup` (the same providers as routing, on the server's text-generation model) once
16k unsummarized characters pile up, and failing or missing it never delays a task.

A chat message may carry attachments, uploaded as pending first like any composer upload. `post` claims
them into group-owned ids (`group-<hash>-…`) so they outlive the 24h pending sweep, and
`assistant_group_messages.attachments_json` keeps them. A task's turn gets its own copies in the member's
thread namespace (`copyForThread`), because thread deletion removes every attachment id a thread's
messages name; sharing the group's ids would delete the group's files with one member's thread. The
group's own files go when the group is removed. Agent posts (`t3_assistant group_post`) still pass
`paths`, which land as links in the text.

A task starts by queueing `group-task:<taskId>:<revision>` into the owner's thread; the reactor maps the
run back by that id and ignores stale revisions, so resume and reassign bump the revision. At most two
tasks run per group. A finished run posts the `result` tool text or the run's last assistant message;
a task with unsettled children waits and runs again with their results. Hand-offs (assign, transfer)
count on the root and the ninth pauses with `handoff_limit`; member replies are a separate limit of two
per request. A subtask may declare `resources` (`folder:<path>` trees, or ids); `pump` holds them only
for running tasks, so a parent waiting on its children never blocks them, and a queued task that waits
claims its resources so a later one cannot overtake it (the wait reason is written without touching
`updated_at`, which orders the queue). A member cancels only tasks its own tasks assigned. Claude pre-approves `t3_group` even in a read-only sandbox, where every other non-read T3
tool is denied: it changes only group state, and a read-only member must still be able to hand work
on. Team changes arrive through `AssistantService.subscribeChanges` (no snapshot, so it never
seeds Jarvis) and `reconcile` heals changes made while the server was down. A scheduled task with
`assistant_team_id` posts through the late-bound `AssistantGroupGate`, since scheduled tasks sit below
assistants in the layer graph.

Read position is `assistant_teams.read_seq` (one per group, not per user: a server has one owner).
The `assistant_team_state` view adds the counters clients show (`AssistantTeam.chat`), so team reads
select from the view, not the table; `ensureForkSchema` recreates it on every start. Counter changes
go out as `teamUpserted` through `refreshTeamChat`, which reaches the assistants stream but not
`subscribeChanges`: reconciling the group on every message would be wasted work. Group finished
notices are client-side (working to idle on that stream), like thread notices.
The mobile push is the exception: `AgentAwarenessRelay` watches the same stream and publishes the finish
as a completion of the last speaker's hidden thread, titled with the group and deep-linked to
`/assistant-groups/<env>/<team>` (the relay takes any `/` path). Members' own completions are silent,
so the relay worker needs no change.

A group's instructions and memories are columns on `assistant_teams` (`instructions`, `memories_json`)
edited through `assistantTeams.update`, and every task packet carries them. Group memories are not in
the memory system: its scopes (user, project, thread) are a synced wire protocol with its own permits,
quotas and hub peers, and a group scope would change that protocol for a short list of facts.

A conversation boundary is a chat row of kind `boundary` (text `new` or `compact`), not a column: its
seq orders it with the messages, clients draw it as a divider, and the newest one's seq is the floor
for what a member's packet, the lead's routing history, the summarizer and the default `t3_group
history` page read. The messages above it stay in the chat and in an explicit `beforeSeq` page. New
conversation also drops the summary; compact writes it first, then the boundary, so a failed summary
leaves the chat unchanged. Seqs are `MAX + 1`, so removing the newest boundary (undo) or clearing the
chat hands the number out again: both lower every member's `seen_seq` and the read position first.
`assistantGroups.conversation` refuses new, compact and clear while a task of the group is queued,
running or waiting, and republishes a snapshot on the group's stream after undo and clear.

An agent changes a group only on a turn the user started. `t3_assistant` `group_create` and
`group_update` read the origin of the calling thread's active run from the message that started it
(`turnOriginOf`, `mcp/turnOrigin.ts`): a `senderThreadId`, `assistant-reply:`, `scheduledTaskId`,
`group-task:` or `autonomy-wake:` message, or a notification, is refused with `capability_denied`; a
client credential with no thread counts as the user. The check is in the MCP handler, so the UI's
`assistantTeams` RPCs are unaffected. A user steering mid-run does not change a run's origin. Each
change then adds a `change` chat row ("Ada added Bo"): never unread, not part of a member's packet.

## Requests between assistants never block

A `t3_thread_send` from one assistant thread to another is a request: it queues (never steers, so the
run's `userMessageId` is the request) and carries a header naming the asker. `assistant_requests`
keys it by that message id. The recipient answers with `replyTo` set to the id; the server claims the
row once (`AssistantRequests.claimReply`) and queues the reply to the asker, which starts a run there.
Reply ids derive from the request id, so a repeat lands once, and a reply is never itself a request.
A reply skips the sender-mode ceiling because the asker opted in. `AssistantRequestReactor` turns a
failed, cancelled or interrupted recipient run into an automatic "Status: blocked" reply; a delivery
failure is the sender's own tool error. Without a `clientRequestId` the key follows the target and
text, so an identical send within one session repeats the same request. Shells carry
`queuedMessageCount` for the row badge.

A send may name several assistants (`threadIds`). Each gets its own request row (`<group>:to:<thread>`)
sharing a `group_id`, all opened before the first send so a fast reply never sees a group of one. Replies
and blocked notices are stored in the rows; `AssistantRequests.settle` claims the group's single
delivery (`delivered`) once none is open, and the caller that completed it sends one
`assistant-reply:<group>` message. `reopen` gives the delivery back with the request.

## The shared folder

`<baseDir>/shared` (not under the owner-only state directory) is visible to every assistant:
`AssistantRuntimePolicy` adds it to `additionalDirectories` of the runtime policy for assistant threads
only, which Claude passes as extra directories and Codex adds to a workspace-write sandbox's writable
roots. Other adapters do not read the field yet. The sandbox container mounts it at `/home/t3/shared`,
which is its own T3 home's `shared`. A send with `paths` copies each file to
`shared/transfers/<senderAssistantId>/<messageId>/` with a manifest written last (name, size, sha256;
a folder with a manifest is complete and a repeat returns it). The sender owns the folder: deleting the
sender, or a send that never delivered, removes it and nothing else under `shared/`.

## Muted lines in the conversation

A rename and a routine's pause or resume leave a line in the assistant's thread through the internal
`thread.notice.record` command: a runless `system_notice` turn item, so it sits in the timeline in
order and the agent never receives it (a `notification` message would start a run). Writing it is
best effort and never fails the change it reports. `ScheduledTaskService` writes the routine lines
from both `setEnabled` and `upsert`, since the editor and `schedule_task enabled=false` save through
the latter.

The Work panel's retry is a normal send: a stopped or usage-limited run is continued, because the
server accepts `manualContinuationOfRunId` only for those, and any other failure asks the same
conversation to try again. Its library reads the transfer manifests (`listLibrary`): files the
assistant sent from its own folder, and files others sent to one of its threads.

## Instructions ride every turn

`assistantNote` prepends `<t3_assistant …>` to every prompt, like the side-chat note. Sending it once
would lose it at compaction, native resume or a provider switch, and an edit to the instructions
would not reach a running conversation. Slash commands skip it so they stay at the start of the prompt.

## Connectors (per-assistant MCP servers)

An assistant row carries `mcp_servers_json`: names, transport, URL or command, and header or env
_keys_ with a `hasValue` flag. The values live in the server secret store (`AssistantConnectors`
names each file by a hash of assistant, server, kind and key) and are never sent to a client or
the `t3_assistant` tool: a write that omits a value keeps the stored one, an empty one clears it, and
deleting a server, a row or the assistant removes its secrets. A rename loses a server's values, so
the editors lock the name once saved.

Providers read connectors at session start through `McpProviderSessions.connectors(threadId)`, a
late-bound source the runtime layer fills (provider-core sits below assistants). It resolves secrets
then, answers from `AssistantDirectory.forThread`, and is empty for any non-assistant thread. One
unreadable secret drops only that connector. Per provider:

- Claude: merged into `mcpServers` next to `t3-code`, never into `allowedTools`, so a read-only
  assistant still asks before calling a connector tool and the runtime mode governs the rest.
- Codex: `mcp_servers.<name>` keys in the same thread config as T3's servers, so launch-argument
  servers survive.
- Cursor: the SDK's `mcpServers` agent option.
- ACP agents (Grok, Kiro, Antigravity, registry agents): appended to whichever list `session/new`
  uses. Command connectors go in every list; http ones only for flavors with `mcpOverHttp`
  (Antigravity, registry agents) and only when the agent takes the http list, so Grok and Kiro run
  command connectors only.
- OpenCode, Pi and Muse: not supported; their adapters ignore connectors.

Command connectors run as the server's user outside any sandbox; the user wrote them, but a
read-only access level does not confine them.

## Autonomy and the loop guard

`AutonomyService` turns domain events into wakes with no model. An assistant's wake is an ordinary
queued message on its thread (`autonomy-wake:<key>` is the message and command id), so it runs
through the same turn path as any message. Three things keep it from feeding itself:

- Signals about `assistant:` threads, subagents, delegated children and side chats are dropped
  before any rule or watch is read. An assistant's own run therefore never triggers a rule.
- A wake is keyed by (run or thread, event, rule or watch, assistant) in `autonomy_wakes`, claimed
  before the send and given back if the send fails, so a replayed event wakes once.
- Rule wakes also share a minimum interval per thread, and every wake counts against
  `maxWakesPerDay`. Watches are asked for, so only the daily cap limits them.

Delivery to the user ends at the wake's run. Activity hides assistant threads, so it gets a decision
whose request id starts with `autonomy:`; `DecisionService` settles such a notice without sending
the assistant anything, otherwise dismissing it would wake the assistant again. Telegram goes to the
first allowed user's chat, unless a reply target already points at Telegram (the reply reactor posts
the run there).

## iMessage channel

`apps/server/src/channels` keeps chat transports out of assistant code: a transport turns its input
into a `ChannelInboundMessage` for `ChannelGateway.ingest`, and `ChannelOutbox` delivers replies at
least once, so a timed-out send is never retried as if it surely failed. The iMessage transport reads
`~/Library/Messages/chat.db` read-only and sends through a fixed AppleScript. Traps:

- Modern `message.date` is nanoseconds past 2^53, and `node:sqlite` throws on such integers; the
  query casts it to REAL.
- Messages records a chat with yourself twice (`is_from_me` 1 and 0) and echoes every reply the
  transport sends. Admission skips echoes by a fingerprint stored before each send and twins by text
  within a few seconds; matching ignores which self chat it landed in.
- Messages sends from the Mac's login (`message.account`). A reply to that same address shows as
  sent by the user, so self-chat replies go to the user's other address, and every self chat maps to
  that one conversation so stickiness and numbered answers carry across.
- `send … to chat id` uses SMS when the chat also has an SMS route; replies go to the handle on the
  iMessage account and fall back to the chat id.

## Telegram channel

The Telegram transport long-polls the Bot API (`getUpdates`), so it needs no public webhook. Traps:

- The bot token is part of every request URL, and an `HttpClientError` carries the request. The API
  client therefore replaces every transport failure with a fixed code and never logs or wraps the
  cause; the token itself lives in the server secret store, never in the settings file.
- The update offset is stored per bot id (the token's numeric prefix) and advances only after the
  gateway stored the message, so a storage failure retries the same update. First enable skips the
  backlog Telegram still holds by asking for the newest update with offset -1.
- Two pollers on one bot get HTTP 409; it surfaces as the `conflict` status. A wrong token backs
  off up to five minutes instead of looping.
- Replies are plain text with no `parse_mode`, cut at 3900 characters per message to leave room for
  the speaker's name under Telegram's 4096 limit. `ChannelReplyAddress` is a union by `kind`; the
  bridge finds an open card by kind and chat, so ids of two channels never collide.

## Sandbox container

[`AssistantSandbox`](../../apps/server/src/assistants/AssistantSandbox.ts) runs one Linux container
with a T3 server inside, named from this environment's id so two Macs never share a name. One
container serves every sandboxed assistant: it is lighter than one each, and an assistant's own
folder inside it is what separates them.

- **The assistant stays here; its work runs there.** `workspace: "sandbox"` changes three things,
  each read from the row at call time, so switching back to `"host"` lifts all of them and keeps the
  container and link.
  1. `AssistantRuntimePolicy` pins the provider policy to the read-only sandbox, whatever the
     access. It leaves the thread's runtime mode alone on purpose: forwarded launches inherit their
     limits from that mode, so the assistant's tool access still decides what the work in the
     sandbox may do.
  2. Launches are refused unless they name the sandbox ([`sandboxRefusal`](../../apps/server/src/assistants/AssistantSandboxPolicy.ts)):
     `t3_thread_launch` in `McpToolAccess.routed`, `delegate_task` and `create_threads` in
     `OrchestratorMcpService`, and a send into a conversation on this machine in
     `ThreadManagementService.dispatch`. The refusal carries the environment id to use. These
     paths read the directory with `Effect.serviceOption`; `McpHttpServer` must be built with
     `AssistantDirectory` in context or the routing silently disappears.
  3. The assistant note says where its workspace is, with the environment id.

  `schedule_task` is refused unless the task is bound to the assistant's own conversation, which
  runs under the read-only policy. Known gap: thread forks and handoffs (`t3_thread_transfer`) can
  still create a thread on this machine with its own runtime mode, because only the assistant's own
  thread is capped.

- **One task in the container, from an assistant that stays on this Mac.** `t3_assistant
  container_task` ([`containerTask.ts`](../../apps/server/src/mcp/toolkits/assistant/containerTask.ts))
  asks the CPU limit once (a decision, stored in `assistant_sandbox_config`, editable in Settings;
  `docker update --cpus` applies it to a container that exists), starts and links the container,
  then calls `RemoteDelegation.delegate` with `cloneMissingProject`, which finds the project there
  by repository or clones and registers it. `RemoteDelegation` tells `AssistantSandboxControl`
  when such a task starts and ends (`assistant_sandbox_task`). The container is discarded
  (removed, volumes kept so sign-ins and clones survive) when the last task ends only if that
  task's call brought it up (`one_off`), the setting says discard, and no sandboxed assistant is
  active; the explicit `container_discard` obeys the same two guards. The user pressing Start
  clears `one_off`. A task's row shows "Assistant sandbox" as where it ran, set at delegation
  because the container's own label is its hostname. After a restart `RemoteDelegation.start`
  follows open tasks again, so the discard still happens when they end.
- **The link is the existing peer link.** [`AssistantSandboxControl`](../../apps/server/src/assistants/AssistantSandboxControl.ts)
  builds and starts the container in the background, mints a pairing credential inside it and calls
  `PeerLinks.link` with full access (the per-call limits narrow it). A live link at the container's
  current address is reused, so a second start links nothing; Docker picks a new host port on every
  restart, so a moved address links again; until then the status is `failed`, not `running`,
  because the old link points nowhere. Nothing relinks on server boot: the user presses Start. The sandbox's environment id lives in the single-row
  `assistant_sandbox` table, which `AssistantDirectory` reads for the refusals and the note.
  Starting turns on `linkedEnvironmentsEnabled` here if it is off, because `PeerLinks.link` and
  `/mcp` routing refuse without it; the status says whether it is on.
- **The image carries this build, not a release.** The fork publishes no Linux CLI archive and
  `npm i t3` is the wrong version, so the service copies this server's `dist` into
  `node:26-bookworm-slim` and runs `npm install` for the runtime-external packages at the versions
  installed beside it. Native modules therefore resolve for Linux. Patches the repo applies to
  `node-pty` and `@ff-labs/fff-node` are not applied in the image. The tag hashes the Dockerfile and
  those versions and the server version, not the contents of `dist`: a rebuilt `dist` at the same
  version reuses the image until it is removed.
- **Loopback only.** The port is published on `127.0.0.1` with a Docker-chosen host port, read back
  from `docker port`. Phones and other machines cannot reach it; they can only through this server.
  That is also why the provider sign-in is a client on the same machine: `assistantSandbox.pairing`
  returns a one-time loopback `/pair` link, which only a client on that machine can open.
- **Seeded once.** The container's first start writes `linkedEnvironmentsEnabled` into its settings
  file if none exists, because both ends of a peer link need the beta. Later edits are kept.
- **Credentials never travel in arguments or logs.** A pairing credential is minted with
  `docker exec … auth pairing create` and returned as `Redacted`.
- **Not built: a macOS VM** for an assistant that needs visual apps. A container cannot run macOS
  apps; this needs a separate VM runtime and its own environment type.
