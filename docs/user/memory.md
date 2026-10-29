# Memory

Memory keeps useful facts and decisions from your conversations so agents find them later. Open
**Settings → Memory** to browse, edit, or forget what was saved. Each environment has its own
memory; pick the one you want to manage.

## Summaries are on by default

When a conversation finishes, T3 Code summarizes it into memory using your text generation model, saving
lasting preferences, decisions, and verified results. A conversation with nothing lasting saves
nothing. Conversations an agent starts as a subtask are not summarized separately.

- **Remember conversations** turns new summaries off. Saved memories stay.
- **Memory model** follows your text generation model. Switch on **Use a separate memory model** to
  choose another one.
- **Allow agent memory access** controls whether agents on that environment can search and save
  memory. Each scheduled task and subagent shows what it may do with memory.

## Save and find memories

Choose **Remember something**, then pick its scope: **All projects**, **Project**, or **Thread**.
Search a memory, open it to read its history, or edit it. Forgetting a memory removes its content, and
other devices drop it when they sync; it is never imported again.

If search coverage is incomplete, an empty result does not prove a memory is missing. Clear the
search to browse instead.

## Import from Claude or Codex

Under **Import memories**, choose Claude or Codex, find the profiles on the selected environment,
preview one, pick the memories, and apply. Up to 32 are applied per batch. Provider originals are
left untouched. If an import is interrupted, use **Check import result** to see what was saved; it
never re-applies automatically.

## Share between your computers

To use the same memory on several of your computers, make one the hub and add the others from its
Memory settings with **Add device**. Connect them first in [Connections](./remote-access.md). You
need settings write permission on both, and a hub address the other computer can reach. Every
device can save and edit equally. **Remove** ends a device's access; turning sharing off keeps the
memories already on that computer.

## Original conversations and conflicts

A memory can link back to its conversation. Under **Original conversations**, allow the devices that
may read it. If two devices change the same memory, only that memory is held while it is resolved
automatically. Open its history to review the result, or revert it within 30 days.
