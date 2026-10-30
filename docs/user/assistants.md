# Assistants

An assistant is a named, long-running conversation you keep coming back to. Each one is a normal
thread with its own model, instructions and tool access, pinned above your projects in the sidebar.
**Jarvis** is the one every environment starts with. It is your general assistant across projects,
and it can't be archived or deleted.

## Create and edit

Open **Settings → Assistants**, or use **+** next to Assistants in the sidebar. Each assistant has:

- **Name** and **handle**. The handle is a short lowercase name that agents use to find it.
- **Project**. The conversation runs in this project's folder. Changing it starts a new conversation,
  because a thread can't move between projects.
- **Model**. Change it from the model picker in the conversation, or in the assistant's settings.
- **Instructions**. Sent with every message, so they keep applying after a long conversation is
  compacted, resumed or moved to another provider. An edit applies from the next message.
- **Tool access**, described below.

## Tool access

| Access              | What the assistant can do                                                      |
| ------------------- | ------------------------------------------------------------------------------ |
| **Read only**       | Read files and search. It can't edit files or run commands that change things. |
| **Workspace write** | Edit files without asking. Other actions can still ask for approval.           |
| **Full access**     | Edit and run commands without approval prompts. This is the default.           |

The level is fixed for the assistant: the permission mode control is hidden in its conversation, and
agents can't raise it. Change it in the assistant's settings; it applies to the next message.
Read only is checked by the provider, so providers differ (see
[Permission modes](./permission-modes.md)). Grok can't enforce it strictly: T3 Code denies the edit
and command requests Grok sends, but Grok may still run some actions without asking. Use a different
provider for an assistant that must not change anything.

## Memory follows the project

An assistant shares memory with its project (and your user memory). To keep one assistant's memory
apart, give it its own project. See [Memory](./memory.md).

## Reset, restore, archive and delete

- **Reset conversation** starts a fresh conversation with the same settings and model. The earlier
  one is archived.
- **Restore** brings back one of an assistant's earlier conversations from **Archived threads**. The
  current one is archived in its place.
- **Archive** hides an assistant and keeps its history. Its handle stays reserved, so an archived
  assistant can come back.
- **Delete** removes the assistant and all of its conversations.

Assistant conversations never appear in project thread lists. Agents can find an assistant with the
`t3_assistant` tool and message its thread, but they can't create or configure assistants.
