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

## Two enforcement points

Tool access is the runtime mode plus, for read only, a read-only sandbox. Both are enforced
server-side so no client or agent can skip them:

1. `AssistantRuntimePolicy` wraps `RuntimePolicyV2` and applies the sandbox on every turn start, so an
   access change takes effect on the next turn without touching the thread.
2. `ThreadManagementService.dispatch` refuses commands that would defeat the assistant: raising the
   runtime mode above its access, archiving or deleting the current thread, unarchiving an old
   generation, and a `titleSeed` renaming the thread. It covers WebSocket and MCP callers alike.

`AssistantService` dispatches through the Orchestrator directly, not `ThreadManagementService`, so its
own archive, delete and unarchive pass the guard. Keep it that way.

Both read the directory with `Effect.serviceOption`, so layers that don't provide it behave as before.
A runtime layer that forgets to provide it silently loses enforcement; `runtimeLayer.ts` must wire it.

## Instructions ride every turn

`assistantNote` prepends `<t3_assistant …>` to every prompt, like the side-chat note. Sending it once
would lose it at compaction, native resume or a provider switch, and an edit to the instructions
would not reach a running conversation. Slash commands skip it so they stay at the start of the prompt.
