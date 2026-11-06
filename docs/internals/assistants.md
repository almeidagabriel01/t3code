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
3. The same `dispatch` refuses a send from one assistant thread to another when neither the org
   chart nor a shared team allows it. `senderThreadId` rides on every agent send (MCP
   `t3_thread_send` sets it), so the guard needs no new plumbing. Org rule
   (`assistantMayMessage`): an assistant with any org relation, or aimed at one, may only message
   its descendants; reports answer through the run their leader waits on. Assistants with no
   relation at all stay free, which is what card #5 shipped. Team rule: two assistants in a common
   team may message each other in any direction, which removes the "never upward, so no cycle"
   argument. The replacement is a cap: `teamSendLimited` refuses a `message.dispatch` once the
   sender sent `TEAM_SENDS_PER_HOUR` (20) messages to its teammates in the last rolling hour, and
   the refusal tells it to report to the user. The count is read from `orchestration_events`
   (messages with an assistant `senderThreadId` into a teammate's conversations, one per message
   id), so nothing is stored twice and it survives restarts. A replay of a send that already ran is
   not capped again.

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

## Teams

An `assistant_teams` row holds members (a JSON array of assistant ids), an optional leader and its
free-text title. A leader and a title are hints in each member's note and badges in the clients;
they never change `mayMessage`. `AssistantService` owns team CRUD and publishes `teamUpserted` and
`teamRemoved` on the assistants stream (the snapshot carries `teams`), so one subscription feeds
every client. Deleting an assistant prunes it from its teams in the same lock and dissolves a team
left below two members; archiving leaves membership alone.

The team view has no storage of its own: `readTeamActivity` reads the member-to-member messages
back from `orchestration_events` (latest event per message id wins, because a message is
re-published while it streams), so the view is exactly what the conversations hold. Text is cut at
4000 characters per row and the view keeps the latest 200 messages.

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

A leader's standup is an ordinary scheduled task whose prompt starts with
`ASSISTANT_STANDUP_PROMPT_HEAD`; `AutonomyService` matches that line on the finished run's task, so a
renamed task still delivers, and sends the result through the same Activity and Telegram path as a
wake, whatever the assistant's mode; only the global pause silences it.

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
