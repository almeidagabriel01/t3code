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
- **Role** and **Reports to**, which place it in a reporting line (see [Reporting lines](#reporting-lines)).

## Tool access

| Access          | What the assistant can do                                                      |
| --------------- | ------------------------------------------------------------------------------ |
| **Read only**   | Read files and search. It can't edit files or run commands that change things. |
| **Edit files**  | Edit files without asking. Other actions can still ask for approval.           |
| **Full access** | Edit and run commands without approval prompts. This is the default.           |

The level is fixed for the assistant: the permission mode control is hidden in its conversation, and
agents can't raise it. Change it in the assistant's settings; it applies to the next message.
Read only is checked by the provider, so providers differ (see
[Permission modes](./permission-modes.md)). Grok can't enforce it strictly: T3 Code denies the edit
and command requests Grok sends, but Grok may still run some actions without asking. Use a different
provider for an assistant that must not change anything.

## Approvals

When an assistant asks to run a command or take another gated action, the request also appears as a
decision in **Activity** and on the mobile Home screen, so you can answer it without opening the
conversation. **Approve** lets it run; **Deny**, **Dismiss** or letting it expire declines it.
Answering in the conversation clears the decision. Only **Edit files** produces approvals: Full
access never asks, and Read only can't run those actions at all.

## Let assistants use your Mac

On a Mac, any agent or assistant can look at your screen and, with your approval, click and type.
Ask for it in plain words, for example "open System Settings and turn on Dark mode".

- **Screenshots** are read-only and need no approval.
- **Every click, typed text and key press needs your approval first.** Each one appears as a
  decision in **Activity** and on the mobile Home screen, so you can approve it from your phone.
  Nothing happens until you choose **Approve**; **Deny**, dismissing it or letting it expire does
  nothing. This applies even to Full access assistants.
- It uses the main screen of the Mac that runs T3 Code.

Grant the permissions in **Settings > Mac permissions**, where each one shows whether it is granted
and opens its pane in System Settings on that Mac:

- **Screen Recording** for screenshots.
- **Accessibility** for clicks.
- **Automation** for typing and key presses.

Use **Check again** after granting one. macOS may ask you to reopen T3 Code before a new permission
takes effect.

## Assistants can consult each other

Assistants don't talk to each other on their own. Ask one to consult another, for example "ask my
researcher assistant for the three most cited papers and summarize them". It finds that assistant
with the `t3_assistant` tool, messages its conversation, and waits for the reply. Any agent can do
this, not only assistants.

## Reporting lines

Give assistants a **Role** (such as CEO or Engineer) and choose who each **Reports to** in its
settings. A leader sees its reports, with their handles, in its instructions, and the assistant list
shows each one's role and leader.

- A leader can ask its reports, and their reports, for work. The report answers through the reply
  the leader is waiting on. A report can't message its leader or anyone outside its branch, so
  assistants never end up messaging each other in a loop. T3 Code refuses such a message and says so. A team (below) is how you let assistants talk in any direction.
- Assistants with no reporting line and no team keep talking to each other freely.
- Archiving or deleting a leader makes its reports top-level again. A leader can't report to its own
  report.

On a leader, **Add daily standup** creates an ordinary schedule for weekdays at 9:00 (your local
time) that asks each direct report for status and then writes one short report. The report reaches
you like an autonomy notice, in **Activity** and on **Telegram**, following the assistant's
channels, even if that assistant only replies when you message it. Pausing **Assistants can notify
you** silences it too. Edit the time or delete the schedule under **Schedules**. The
standup is recognised by the first line of its prompt, so keep that line when you edit it.

## Teams

A team is a group of assistants that talk to each other while you watch. Under **Settings >
Assistants > Teams**, choose **New team**, name it and pick at least two members. An assistant can be
in several teams. The sidebar and Home list your teams under the assistants.

- Members may message each other in any direction, and each member's instructions list its
  teammates. Ask one to "check with the team" and it asks a teammate.
- Open a team (**Activity**, or its row in the sidebar or Home) to read every message the members
  sent each other, oldest first, and jump to the conversation it landed in.
- A leader is optional. Choose one among the members and give it a title such as CEO, CFO or Head
  of Research. Teammates are told to report their results to it, and the title shows next to its
  name. The leader does not change who may message whom.
- To keep two assistants from answering each other forever, one assistant may send at most 20
  messages an hour to its teammates. Past that, T3 Code refuses the send and the assistant reports
  to you instead.
- Deleting an assistant removes it from its teams. A team left with fewer than two members is
  deleted. Archived members stay in the team and come back when unarchived.

## Schedules

An assistant's settings list the scheduled tasks that run in its conversation. **New schedule** opens
the task editor already pointed at that conversation. Schedules belong to the assistant: they follow
it through a reset, a restore or a project change. An assistant can also schedule its own work when
you ask it to.

## Autonomy

Assistants can wake on their own when something needs you, instead of waiting to be asked. T3 Code
watches its own events with no model involved, and only a match sends the assistant a short message.
The assistant investigates with its own model and tells you; it does not change anything.

Autonomy is **off** until you turn it on in **Settings → Assistants → Autonomy**, which holds:

- **Assistants can notify you.** The pause switch: off stops every rule and watch at once. The
  command palette has **Pause assistant notifications** / **Turn on assistant notifications**.
- **Rules.** Run failed or interrupted, waiting for you too long (30 minutes by default), run stuck
  with no activity (15 minutes; waiting for an approval doesn't count), PR checks failed, and a card
  that reaches Review with unchecked checklist items. Each one can be turned off.
- **Channels.** The answer reaches you in **Activity** (T3 and the mobile app) and on **Telegram**
  (the first allowed user), even when you are not chatting with that assistant there. If Telegram
  is not set up, the section says so and links to its settings.
- **Notifications per day**, 20 by default.

Each assistant decides for itself, under **Notifications** in its settings: **Only reply when I
message it** (the default) never wakes on its own, **Reply and notify me** does. It can use its own
rule list, only some projects, and its own channels; the most specific setting wins. An assistant's
spending limit still applies. Assistants, subagents and delegated tasks never trigger anything, so
an assistant can't set off itself.

### Reminders and watches

Ask an assistant in plain words. "Remind me tomorrow at 9am to renew the domain" creates a one-time
schedule. "Tell me when the checks on PR 42 pass" creates a **watch**: a filter (project, thread,
event, PR) plus what to do when it matches, which can fire once or stay on, and can expire. Pause or
delete a watch whenever you like; it stops immediately. Watches only wake assistants set to reply
and notify. An assistant's settings list its watches under **Watches**, where you can also add,
edit, pause or delete one by hand.

## Spending limit

Turn on **Spending limit** in an assistant's settings to cap it by day, week or month. Spending is
estimated at API prices from the assistant's turns, across all of its conversations; with a
subscription it is a guide, not a bill. **Stop when reached** refuses new messages until the period
resets; with it off, you only see a warning. The assistant list shows **Near limit** and **Limit
reached**.

## Talk to them over iMessage

On a Mac, **Settings → iMessage** lets you message your assistants from Messages and get their
replies in the same chat. It works while T3 Code is running on that Mac.

1. Turn on T3 Code in System Settings → Privacy & Security → **Full Disk Access**, then **Check
   again**.
2. Add your own phone number and Apple ID email under **Chat with yourself**. Once access is
   granted, the numbers and emails this Mac's Messages sends from show there, ready to add with one
   click. If the Mac's Messages uses an Apple ID of its own, add the people allowed to write to it
   under **Other accounts** instead.
3. Turn on **Use iMessage** and send yourself a message. Allow T3 Code to control Messages when
   macOS asks.

Start a message with `@Name` to pick an assistant; the default one answers otherwise, and the chat
stays with the last one you picked. Send `@` on its own to list them. Approvals arrive as numbered
choices: reply with the number. Only blue iMessage bubbles reach the Mac, so a chat with yourself
that your phone sends as SMS or RCS is not read; write to your Apple ID email instead. Replies come
from your other address, so they read as incoming on your phone.

While a conversation is in Messages, the T3 Code mobile app does not also push its replies; send
the assistant a message from the app and its notifications come back. More than 10 messages a
minute from one person are held back, with one notice.

## Talk to them over Telegram

**Settings → Telegram** lets you message your assistants from the Telegram app, on any computer
that runs T3 Code; it needs no public address. It works while T3 Code is running.

1. In Telegram, open `@BotFather`, send `/newbot` and follow the steps. It replies with a bot token.
2. Paste the token under **Bot token**. It stays on the server and is never shown again; paste a new
   one to replace it, or remove it.
3. Turn on **Use Telegram**, open your bot, press Start and say hello. You show up under **Waiting
   for approval**; press **Allow** next to your name. Anyone else who writes to the bot waits there
   until you allow or ignore them, and is told that their message is waiting. If you prefer, add a
   numeric Telegram user id by hand under **Who can write to the bot**.

Start a message with `@Name` to pick an assistant; the default one answers otherwise, and the chat
stays with the last one you picked. Send `@` on its own to list them. Telegram's `/` menu lists them
too: `/name text` works like `@Name text`, and `/name` alone switches to that assistant. Approvals
arrive as numbered choices: reply with the number. Only private chats with the bot are heard; groups and attachments
are not. More than 10 messages a minute from one person are held back, with one notice.

If the status shows an error, it says what to fix; T3 Code keeps retrying, waiting longer after each
failure, and turning the switch off stops it at once. Two programs cannot read the same bot at the
same time, so use one bot per T3 Code server.

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
