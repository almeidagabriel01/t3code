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
- **Projects**. **All projects**, or the projects you tick. The conversation runs in the first one
  (its home); changing the home starts a new conversation, because a thread can't move between
  projects, but adding more projects does not. An assistant with real projects is a **project
  assistant**: it shows a project badge, is listed under each of its projects, and may only launch,
  delegate and message work inside them (see [Project assistants](#project-assistants)).
- **Model**. Change it from the model picker in the conversation, or in the assistant's settings.
- **Instructions**. Sent with every message, so they keep applying after a long conversation is
  compacted, resumed or moved to another provider. An edit applies from the next message.
- **Tool access**, described below.
- **Workspace**: **This Mac** or a **Sandbox container**, described in
  [Work in a sandbox](#work-in-a-sandbox).
- **Role**, free text such as CEO or Engineer. The assistants in its groups see it as that teammate's role.

## Project assistants

An assistant set to **All projects** works across all your projects. One set to real projects is a
project assistant. It works in its own projects plus those of its groups (see
[Group projects](#group-projects)). T3 Code refuses its launches, delegated tasks and messages to
agent conversations in any other project, and tells it why. It can still message other assistants.

A project assistant with more than one project never falls back to its first one. It has to name
the project when it starts work, and asks you when your request does not make it clear. Its
delegated tasks would run in its own conversation's project, so it starts a thread in the right
project instead. Editing an assistant shows the projects it gets from its groups apart from its own.

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

### Send one task to the sandbox

An assistant that works on your Mac can still run a single task in the sandbox when you ask, for
example "run the CI in the container". The rest of its work stays on the Mac.

- The first time, you are asked how much CPU the sandbox may use: **No limit** or a number of
  cores. You can change it later in **Settings → Assistants → Sandbox → CPU limit**, and the change
  also applies to a sandbox that is running. On a Mac the most it can use is the number of CPUs
  Docker Desktop has.
- If the project is not in the sandbox yet, it is cloned there. The sandbox has none of your Mac's
  git sign-ins: for a private GitHub repository, sign the sandbox in once at **Settings →
  Assistants → Sandbox → Sign in to GitHub**, enter the code it shows on GitHub, and it stays signed
  in until you sign it out or remove the sandbox with its files. This works from a phone too.
- **When a task is done** decides what happens to a sandbox that was started only for tasks:
  **Discard the container** removes it once its last task ends, and keeps its files and provider
  sign-ins. **Keep the container** leaves it running. A sandbox you started yourself, or one an
  assistant works in, is never discarded. You can also ask the assistant to discard it.

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
access never asks, and Read only can't run those actions at all. With **Notify me when something
is waiting for me** on (see [Autonomy](#autonomy)), an approval or question in any other
conversation also becomes a decision once it has waited past the delay, with the same rules.

## Let assistants use your computer

On the computer that runs T3 Code (macOS, Windows or Linux), any agent or assistant can read an
app's controls and, with your approval, click and type. Ask for it in plain words, for example
"open System Settings and turn on Dark mode".

- **Looking** (screenshots and the list of an app's controls) is read-only and needs no approval.
- **Every click, typed text and key press needs your approval first.** Each one appears as a
  decision in **Activity** and on the mobile Home screen, so you can approve it from your phone.
  Nothing happens until you choose **Approve**; **Deny**, dismissing it or letting it expire does
  nothing. This applies even to Full access assistants.
- It uses the main screen of the computer that runs T3 Code.

### On a Mac

Grant the permissions in **Settings > Mac permissions**, where each one shows whether it is granted
and opens its pane in System Settings on that Mac:

- **Screen Recording** for screenshots.
- **Accessibility** for clicks.
- **Automation** for typing and key presses.

Use **Check again** after granting one. macOS may ask you to reopen T3 Code before a new permission
takes effect.

### On Windows and Linux

There are no permissions to grant. **Settings > Computer use** shows what agents can do on that
computer and where the platform stops them:

- **Windows:** everything works when T3 Code runs in your signed-in desktop session. It cannot
  reach a service session, the lock screen, UAC prompts or administrator windows.
- **Linux on X11:** controls, clicks and keys work. Whole-screen screenshots work only without a
  compositing window manager, so on desktops such as GNOME agents work from the list of controls.
- **Linux on Wayland:** controls work. The desktop asks you to allow screenshots the first time;
  answer that dialog on the computer. Agents cannot click by screen position, and key presses work
  on GNOME only.

On Linux, start T3 Code inside your desktop session. A server started from a plain SSH shell or a
system service has no screen to use, and the page says so.

## Tasks

An assistant answers quick things itself. For real work that takes several steps in code, it
starts a thread in the right project with a full brief, using its instructions, model and access. You
are not asked to wait: when the thread finishes, the assistant wakes up, checks the result, runs the
tests, asks a teammate to review when that helps, sends fixes back, and only then tells you.

The threads an assistant launched are listed under it in the sidebar and on the Assistants page with
their state (running, waiting, done or failed). Open one to see the work; the thread shows the
assistant's face in the mood of the task, and tapping it returns to the assistant. A project assistant
can only start tasks in its own project. You can dismiss a finished task from the list, and restore it later; an assistant does the same when you ask it to.

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
- Deleting an assistant removes it from its groups, which stay even when they end up empty. Archived
  members stay in the group and come back when unarchived.

### Group projects

A group can have projects of its own, and every member may work in them on top of its own projects.
Give a new project to a whole team in one step:

- From the group: open its settings and tick the projects under **Projects**. The settings show how
  many members gain access.
- From the project: under **Settings > Projects**, open the project and use **Assistants with
  access** to tick groups, or single assistants. After you add a project, T3 Code offers the same
  choice.

Someone who joins the group later gets its projects too. Taking a project away from the group keeps
it for any member that has it on its own list. Archived projects stay in the list, marked as
archived. Each member's instructions list its groups' projects by name, so you do not have to write
them in by hand.

### Group chat

Click a group in the sidebar (or tap it on Home) to open its chat. A message there is a request to
the members; it does not run an agent by itself.

- Write `@Ada @Beto` anywhere in the message to give each of them a task, or `@everyone` for all
  members. Names with spaces work (`@Ana Paula`). The line under the box says who will get it.
- With no mention, a short "continue" resumes the group's stopped task, and while exactly one task is
  open your follow-up goes to its owner. Otherwise the group's **Lead** picks who answers (and may
  decide nothing needs doing, as for "thanks"). Set one in **Edit group**; it only routes and gets no
  extra permissions. A group with one member sends everything to it. Without a lead the message waits,
  and is routed once you set one. Routing needs a lead on Claude, Codex or Antigravity.
- **Reply** on a member's message sends your follow-up to that member.
- Each task shows as a card with its owner and status. **Stop** pauses running work, **Resume**
  continues it, **Reassign** gives it to another member and **Cancel** ends the whole request.
  **Open conversation** shows the member's own thread for this group.
- Members can give each other subtasks, hand a task over, or ask each other one short question (two
  per request). So members cannot pass work around forever, a request stops whole, and the chat
  says why, after 12 hand-offs in which nobody delivers a new result, or after 30 hand-offs since you
  last acted on it. **Resume**, **Reassign** or "continue" on any of its cards picks it up with its
  subtasks; that, or any message you send to its members, starts both counts over. At most two tasks
  run at the same time in a group; the rest wait their turn.
- **Group routines** (group menu) lists the scheduled messages that post in the chat, for example a
  morning status request, with the next run in your local time, the last result, **Run now**, pause
  and resume, edit and delete. A routine can stop after a number of runs, and a daily or weekly one
  can skip or run once when T3 Code was off at its time. A member creates or changes a routine only
  when you asked for it in the group. Each change leaves a muted line in the chat.
- **Archive group** keeps the chat but stops its work and takes no new messages. Restore it from the
  group's banner, the Assistants page or Settings > Assistants > Archived groups.
- A group with messages you have not read shows a count in the sidebar and on Home. Opening the
  chat draws a **New** line above the first one and marks the chat read once the newest message has
  been in view. **Mark as unread** and **Mark as read** are in the group's menu. When a group finishes
  the work of a request while you are elsewhere, you get the usual completion notification with the
  last answer's start (web and desktop; the phone shows the count only).
- **Group settings** (group menu) holds instructions every member gets with each task, a short list
  of group memories, and the conversation actions. **New conversation** and **Compact context**
  (summarizes first) draw a divider: members read only what comes after it, and the older messages
  stay above. **Undo divider** removes the latest one while nothing follows it. **Clear history**
  deletes the chat, its tasks and files after you confirm. These wait until the group stops working.
- An agent in any conversation can post a request into a group ("ask the Leadership group to…").

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

## The Work panel

**Work** on an assistant's card, in its sidebar menu and in its thread menu (the web and the mobile app
alike) shows what it is up to in one place.

- **Status** says whether it can work now. When it cannot (its project is gone, its sandbox is
  stopped, its provider is signed out or its model is no longer offered), the card says why and has a
  button that goes to the fix. A paused Autonomy switch is shown too, with a button to resume it.
  **Retry** appears when its last run failed or was stopped.
- **Routines** are the schedules that run in its conversation, with the next run in your local time, a
  pause and resume switch and **Run now**. Pausing or resuming a routine, and renaming the assistant,
  leave a muted line in its conversation.
- **Memory** lists what its conversations taught the memory, with the scope and a link to the
  conversation each came from. Edit or forget a memory there. On mobile, tapping a memory opens it in
  Memory to edit.
- **Library** lists the files it handed to other assistants or received from them in the shared
  folder. Open or reveal them on the machine that runs the server.

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
- **Notify me when something is waiting for me.** A direct notice, with no model, whenever any
  conversation waits on you: an approval, a question, an open decision or a paused group task. It
  goes out after **Notify after** (1 minute by default), only once, and never for something you
  answered in the meantime. It has its own switch, respects the pause switch and does not count
  toward the daily limit.
- **Notifications per day**, 20 by default.
- **Messages from assistants per day**, 20 by default: short messages an assistant sends you itself.

Each assistant decides for itself, under **Notifications** in its settings: **Only reply when I
message it** (the default) never wakes on its own, **Reply and notify me** does. It can use its own
rule list, only some projects, and its own channels; the most specific setting wins. An assistant's
spending limit still applies. Assistants, subagents and delegated tasks never trigger rules, so an
assistant can't set off itself; a one-time watch on one of those conversations still fires for the
assistant that set it. Ask an assistant to turn its own notifications on or off and it changes this
setting for you; it can only do that in a message you sent.

An assistant can also send you a short message of its own, with a link to a conversation when it
has one. It reaches Activity and Telegram (or iMessage when Telegram is off), never carries files or
secrets, and stops while autonomy is paused.

### Reminders and watches

Ask an assistant in plain words. "Remind me tomorrow at 9am to renew the domain" creates a one-time
schedule. "Tell me when the checks on PR 42 pass" creates a **watch**: a filter (project, thread,
event, PR) plus what to do when it matches, which can fire once or stay on, and can expire. Pause or
delete a watch whenever you like; it stops immediately. Watches and reminders work whatever the
assistant's notification mode, and their answer reaches Activity and Telegram. An assistant's settings list its watches under **Watches**, where you can also add,
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

When **Notify me when something is waiting for me** is on (see [Autonomy](#autonomy)), the bot also
tells you when any conversation waits on you: who is asking, the project and conversation, a short
summary and a link to open it in T3 Code. Approvals and single-choice questions come with numbered
choices; anything else says to answer in T3 Code. A number answers the newest card, and the bot then
names the next one still waiting. Without Telegram, the notice goes to iMessage when it is on, and
always to Activity.

If the status shows an error, it says what to fix; T3 Code keeps retrying, waiting longer after each
failure, and turning the switch off stops it at once. Two programs cannot read the same bot at the
same time, so use one bot per T3 Code server.

## Memory follows the project

An assistant shares memory with its project (and your user memory). To keep one assistant's memory
apart, give it its own project. See [Memory](./memory.md).

An assistant with several projects names the project a fact belongs to when it saves it, or saves it
for you everywhere when it holds for all of them. When it looks something up, it searches all of its
projects.

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
