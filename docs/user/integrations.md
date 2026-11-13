# Integrations

Integrations connect services such as Linear, Gmail, Google Calendar, Slack or
Notion once per environment, so your assistants can use them on every
supported provider. You sign in on the service's own site; the sign-in stays
on the machine that runs the environment and never reaches an agent.

## Connect a service

Open **Settings → Integrations** (also in the command palette), find the
service and choose **Connect**. Sign in on the page that opens, then come back:
the row moves to **Connected**.

- **Paste the address from the browser.** When the sign-in page can't return
  to T3 on its own, for example from a phone on a plain local network, T3 asks
  you to paste the address the browser shows after you sign in.
- **Some services need your own app.** Google, Microsoft and a few others
  don't let T3 sign in on its own. Choose **Use your own app**, create an OAuth
  app on their setup page, add the addresses T3 lists, and paste its client ID
  and secret. Gmail and Google Calendar share one app. **Remove app**
  disconnects everything that used it.
- **Use a token instead.** Some services also take an API token, from the
  row's menu.
- **Needs sign-in** or **Needs more access** means the service asked for a new
  sign-in: choose **Reconnect**.

To stop using a service, open its row and choose **Disconnect**.

## Already set up in Claude Code, Codex or claude.ai

T3 lists servers you set up in Claude Code, Codex or claude.ai, labeled with
where they come from. It only reads those settings and never changes them.

- The provider's own copy wins: Claude assistants keep using a server set up in
  Claude Code or claude.ai, and T3 doesn't add a second one there.
- **Connect for other providers** (or **Connect in T3**) connects the same
  service in T3 for the providers that don't have it.
- **Make available to all providers** copies a Claude Code or Codex server into
  T3's [MCP servers](./global-mcp-and-skills.md) after showing what it copies.
  A server that signs in on its own copies only its address; connect it in T3
  afterwards. claude.ai connectors can't be copied.

## Who can use it

By default only assistants get a connected service. In its detail, choose
**All threads** to give it to every thread on the environment.

Each assistant uses **All connected** integrations unless you choose some in
its settings. Only you change that choice; agents can see it but not change
it.

## What assistants may do

The assistant's tool access applies to every service:

- **Read only** assistants can look things up but not change anything, such as
  sending an email or creating an issue.
- With **Ask before acting**, or with workspace write access, the assistant
  asks you before each change.
- **Full** access acts without asking.

Threads that aren't assistants ask as they do for any other MCP tool.

## Limits

- Integrations work in Claude, Codex, Cursor, Antigravity, registry agents,
  Grok, Kiro and fx. OpenCode, Pi, Muse Code and cloud agents can't use them,
  and T3 shows **Not available on** that provider.
- An assistant's own conversation can use them, but work it sends to the
  sandbox container can't.
- Agents can list your integrations and their status, but they can't connect
  one. When you ask an agent to connect a service, it sends you a link to that
  service in Integrations.
