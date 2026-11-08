# T3 MCP servers and skills

T3 can give its agents MCP servers and skills of its own, on top of the ones
each provider already has. You set them up once per environment, and every
supported provider gets them. They live on the machine that runs the
environment, so a remote environment uses its own servers and skills.

This is the opposite direction of [outside agents](./outside-agents.md), which
lets agents outside T3 call into it.

## Add MCP servers

In **Settings → Providers → MCP servers** (on mobile, **Settings → MCP servers &
skills**), add a server for the selected environment: a command to run (stdio)
or an HTTPS address (HTTP). Put tokens in environment variables or headers; T3
stores those values as secrets and shows them masked. Don't put secrets in the
address itself. Each server has its own switch.

Servers apply to threads started after you add them. Agents see each one as
`<name>_t3`.

| Provider                         | stdio | HTTP |
| -------------------------------- | ----- | ---- |
| Codex, Claude, Cursor            | Yes   | Yes  |
| Antigravity and registry agents  | Yes   | Yes  |
| Grok, Kiro, FX                   | Yes   | No   |
| OpenCode, Pi, Muse, cloud agents | No    | No   |

Names ending in `_t3` are T3's, so avoid them in provider settings.

## Add skills

A skill is a folder with a `SKILL.md` file. To give one to every provider, put
the folder in the T3 skills folder on the machine that runs the environment
(normally `~/.t3/skills`). In **Settings → Providers → T3 skills**, choose
**Rescan**; the section then shows the exact folder path and lists the skill.
The folder name must use lowercase letters, digits, and hyphens.

Call a skill in a message with `$t3:<folder-name>`. The composer's `$` menu
lists T3 skills with a **T3** badge, next to the provider's own skills. T3
reads the skill when you send the message, so edits apply right away.

Turn a skill off or remove it in the same section. Removing deletes the folder;
if the folder is a link, only the link is removed.

A message carries up to eight T3 skills. Very long skills are shortened, and
the agent is told where to read the full file.
