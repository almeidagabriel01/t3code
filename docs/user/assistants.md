# Assistants

An assistant is a named, long-running conversation you keep coming back to. Each one is a normal
thread with its own model, instructions and tool access, pinned above your projects in the sidebar.
**Jarvis** is the one every environment starts with. It is your general assistant across projects,
and it can't be archived or deleted.

## Create and edit

Open **Settings → Assistants**, or use **+** next to Assistants in the sidebar. Each assistant has:

- **Name** and **handle**. The handle is a short lowercase name that agents use to find it.
- **Avatar**. A robot in a color you pick, or your own PNG, JPEG or WebP image up to 2 MB. Until you
  pick one, the robot comes from its handle.
- **Project**. The conversation runs in this project's folder. Changing it starts a new conversation,
  because a thread can't move between projects. Choosing a real project makes it a **project
  assistant**: it shows a project badge, is listed under that project, and may only launch,
  delegate and message work inside it (see [Project assistants](#project-assistants)).
- **Model**. Change it from the model picker in the conversation, or in the assistant's settings.
- **Instructions**. Sent with every message, so they keep applying after a long conversation is
  compacted, resumed or moved to another provider. An edit applies from the next message.
- **Tool access**, described below.
- **Workspace**: **This Mac** or a **Sandbox container**, described in
  [Work in a sandbox](#work-in-a-sandbox).
- **Role**, free text such as CEO or Engineer. The assistants in its groups see it as that teammate's role.

## Project assistants

An assistant that lives in **No project** works across all your projects. One that lives in a real
project is a project assistant. T3 Code refuses its launches, delegated tasks and messages to agent
conversations in any other project, and tells it why. It can still message other assistants, under the
usual [reporting line and team rules](#reporting-lines).

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

## Work in a sandbox

An assistant can do its work in a Linux container instead of on your Mac. The assistant itself stays
where it is, with its conversation, mobile access, connectors and secrets. What changes is where its
commands and file edits happen: they run inside the sandbox, and on your Mac the assistant can only
read. Its tool access then applies to the work in the sandbox.

1. Install and start Docker on the Mac that runs T3 Code.
2. In the assistant's settings, set **Workspace** to **Sandbox container (Linux, Docker)**. The
   choice is off, with a reason, while Docker isn't running.
3. T3 Code starts the sandbox in the background. The first start builds its image from this build
   of T3 Code and takes a few minutes. It also turns on **Linked environments** (Settings → Labs),
   because the sandbox is linked to your Mac like another machine. Nothing else in your settings
   changes.
4. Sign each provider in to the sandbox once: **Settings → Assistants → Sandbox → Sign in**. The
   sandbox has its own sign-ins and does not use the ones on your Mac. This opens the sandbox's
   Providers settings, and works from the Mac that runs the sandbox. From a phone or another
   machine, do it from the Mac.

**Settings → Assistants → Sandbox** shows its status (Not created, Starting, Running, Stopped,
Docker not available, or Failed with the reason) and has **Start**, **Stop** and **Remove**. Remove
asks whether to also delete the sandbox's files, which include the provider sign-ins and everything
assistants wrote there. Switching an assistant back to **This Mac** keeps the sandbox.

Limits:

- It is Linux only. There are no GUI apps and no Mac apps, so work that needs them still runs on the
  Mac.
- The sandbox listens on this Mac only. Phones and other machines reach it through T3 Code.
- A sandboxed assistant that tries to launch work on the Mac, or message a conversation there, is
  refused and told to use the sandbox.
- A macOS virtual machine for visual apps is not built.

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
with the `t3_assistant` tool and messages its conversation. Between assistants nothing blocks: the
asker sends and ends its turn, and the answer arrives later as a new message that wakes it. If the
other assistant's run fails or is cancelled before it answers, the asker gets a "Status: blocked"
message instead of silence. Messages waiting behind an assistant's active run show as "3 queued" on
its row. To ask several assistants at once, say so in one request: their answers are held and arrive
together as one message.

### Shared folder and sending files

Every assistant can read and write the `shared` folder inside T3 Code's data folder (`~/.t3/shared` by
default), and the sandbox sees it at `/home/t3/shared`. To hand files over, ask an assistant to send
them (up to 10 files, 100 MB each and 250 MB in all). T3 Code copies them into `shared/transfers/` when
it sends, so the recipient keeps a stable copy, and the message shows them as links that open in the
file viewer. Deleting an assistant removes the files it sent. A sandbox created before this feature
needs to be recreated to see the folder.

## Groups

A group is a set of assistants that work together. Create one from the sidebar (**+** next to
Groups) or under **Settings > Assistants > Groups**: give it a name, then add members now or later. A
group can be empty or hold a single assistant. An assistant can be in several groups. The sidebar and
Home list your groups under the assistants.

- Any assistant may message any other. Each member's instructions list its groupmates with their
  handle and role and tell it that it may hand work to them. Ask one to "check with the group" and it
  asks one.
- A group's **Lead** is optional. It routes requests that mention no one, arriving with the group
  chat, and gets no extra permissions.
- Deleting an assistant removes it from its groups, which stay even when they end up empty. Archived
  members stay in the group and come back when unarchived.

## Agents can create assistants

Ask any agent to "make an assistant that reviews my PRs" or "put Ana and Bob in a group". It uses the
`t3_assistant` tool to create, edit, archive and group assistants.

- **You choose the tool access.** If you don't say which level, the agent asks you: use the default
  (up to its own level) or a custom setup.
- **At or below the agent's own level**, the assistant is made right away.
- **Above it** (or when changing an assistant that has more access than the agent), nothing happens
  until you approve. The request shows up as a decision card; when you approve, the agent repeats the
  call and the assistant is made once.
- Groups can be created and changed without approval, using only active assistants.

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

T3's own messages in chats (approval buttons, "Reply with the number", notices) follow **Language**
in **Settings → iMessage** and **Settings → Telegram**, one setting for both: Automatic uses your
Mac's language, or pick English or Português (Brasil). Assistants answer in the language you write
in.

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
`t3_assistant` tool and message its thread.
