# Running T3 Code in the background

On Linux and macOS, T3 Code can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the `t3` CLI first ([Install T3 Code](./install.md#command-line)), then
run these commands on the machine that will host T3 Code:

| Task                                  | Command                |
| ------------------------------------- | ---------------------- |
| Set up access from your other devices | `t3 up`                |
| See how your other devices reach it   | `t3 status`            |
| Install and start                     | `t3 service install`   |
| Inspect status and log location       | `t3 service status`    |
| Move to a newer release               | `t3 update`            |
| Restart                               | `t3 service restart`   |
| Stop and remove from startup          | `t3 service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.
Running `t3 service install` again repairs a service that `t3 service status`
reports as broken.

`t3 update` downloads the newest release on your channel and switches `t3`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `t3 service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating T3 Code](./updating.md).

Pass an exact version (`t3 update 0.0.42`) to pin one, `--channel nightly` to
switch trains, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `t3 update` ask for confirmation before
installing one.

`t3 uninstall` removes the background service, the `t3` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.t3/userdata` are kept, along with `service.env`
under T3 home. Pass `--yes` from a script.

## Keep the computer awake

Agents stop when the computer sleeps. In Settings → Maintenance (and on mobile,
Settings → Maintenance), **Keep this computer awake** can hold the machine that
runs T3 Code awake **while agents are working** or **always**. It is off by
default, works on macOS and on Linux with `systemd-inhibit`, and shows a coffee
cup in the status bar while it is active.

Closing a laptop lid still puts it to sleep unless it is plugged in with an
external display.

## Heavy work queue

When several agents run tests, builds or simulators at once, they queue on the
machine that hosts T3 Code. Agents put the command behind `t3 heavy`, and the
queue starts jobs in order. In Claude sessions T3 Code starts, heavy Bash
commands (tests, builds, type checks, `git commit` with its hooks, simulators)
go through the queue on their own, even when the agent forgets. Open the **Resource Manager** in the status bar to
see each job with a short name (agents give one with `--name`; otherwise T3
derives it from the command, which shows below it) and its project, the thread that queued it, how long it has run
or waited, and why a waiting job has not started ("waiting for room: needs
~4 GB, 1.2 GB free", "letting the last one ramp up", "paused"). On mobile it is
under Settings → Maintenance.

- **Slots.** Settings → Maintenance → **Heavy work** sets how many jobs run at
  once (default 3; 1 is strictly one at a time). The next job starts only when
  the machine has room for what that command used in its last runs, and a few
  seconds after the previous start so its real load shows first. A later,
  shorter job may go ahead of one that does not fit yet, but only if it will
  finish before that one fits. Simulators, emulators and the dev app run alone.
  Running jobs are never stopped to relieve pressure.
- **Memory pressure.** On macOS, a second job waits while the system reports
  memory pressure or is swapping heavily, whatever the free percentage says;
  memory held by running simulators and emulators counts as used. A lone job
  always starts. Each job's test runner gets as many workers as the machine has
  free cores (`VITEST_MAX_WORKERS`, `T3_HEAVY_WORKERS`).
- **Reorder.** Drag a waiting job, or use its **⋯** menu: **Run next**, **Move
  up**, **Move down**, **Move to end**, **Open thread**, **Remove**. A running
  job's menu has **Stop**, which ends its `t3 heavy` command.
- **Priority per project.** In the same menu, set **Always first** or **Last**
  for the job's project. New jobs from that project go ahead of, or behind,
  normal ones; jobs already queued and jobs you moved by hand keep their place.
  Settings → Maintenance → **Heavy work** lists the rules so you can remove them.
- **Priority per job.** Commands you run in T3 Code's terminal go ahead of the
  ones agents queue. **High priority now** in a job's menu starts a waiting job
  right away; agents can ask for it with `t3 heavy --priority high`. On macOS,
  **Lower priority** moves a running job to background CPU priority and its row
  shows **Low priority** until **Normal priority** gives it back. macOS has no
  CPU priority above normal for a running job.
- **Claude Code hook.** Settings → Maintenance → **Heavy work** → **Claude Code
  hook** adds a hook to your Claude Code settings (`~/.claude/settings.json`, or
  `CLAUDE_CONFIG_DIR`) so Claude sessions outside T3 Code queue heavy commands
  too. Turning it off removes only that hook. A command run through the queue
  starts in a fresh shell, so a `cd` inside it does not carry over.
- **Idle simulators.** An emulator or simulator T3 Code opened powers off after
  20 minutes in which nobody opened it, held it or ran an agent command on it
  (Settings → Maintenance → **Heavy work** → **Power off idle simulators**;
  **Off** keeps them on). Opening it again boots it. Devices T3 Code has not
  opened since it started are left alone.
- **Pause.** The **Pause** switch (also in Settings) stops anything new from
  starting while running jobs finish. A pause icon appears in the status bar.
- **Off.** Settings → Maintenance → **Heavy work** → **Heavy work queue** turns
  the queue off. Every heavy job then starts right away, jobs that were waiting
  included, and agents stop asking whether to run now or queue. Use it when the
  machine has power to spare, or when you would rather have everything run at
  once than wait. The Resource Manager still lists what is running. The slot
  limit, the pause and the priority rules keep their values and apply again
  when you turn the queue back on; jobs already running are not stopped.

**Heavy commands** in the Resource Manager (on mobile, Settings → Server
controls) lists every heavy command running now, queued or not: tests, builds
or bundlers an agent or terminal started directly show there too once their
processes use at least half a core or 1 GB for a few seconds. Each row shows
its thread and project, CPU (cores and share of the machine), memory, the peak
seen since T3 started watching it, and how long it has run. **Stop** ends the
command and everything it started. The section appears only while something
heavy runs.

Agents never reorder the queue on their own. They may move a job up only when
you ask them to in the conversation, and the job's note says an agent did it.

## Local network access

A new service answers only on this machine. Other devices reach it through
T3 Connect, or directly once you choose the local network in `t3 up` (or run
`t3 up --lan`, which sets `T3CODE_LAN=true` in `service.env`). It then listens on
your local network and Tailscale addresses, so the desktop and mobile apps on
the same network connect directly instead of through T3 Connect. It still does
not answer on public addresses. Anyone on the same network can reach the port,
so a pairing code is all that keeps them out. The hosted web app at app.t3.codes
stays on T3 Connect, because browsers block plain HTTP from an HTTPS page.

A service installed before `T3CODE_LAN` existed keeps listening on the local
network. `t3 status` says so, and `t3 up --no-lan` turns it off. Any
`T3CODE_HOST` value replaces this setting.

## Configure the service environment

Put custom environment variables in `service.env` under the service's T3 home
directory, normally `~/.t3/service.env`. This file survives service installation
and updates. For example:

```dotenv
T3CODE_PORT=3773
T3CODE_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `T3CODE_HOME`,
`T3_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT` (including case variants).

Run `t3 service restart` after changing the file. Changes apply when the service
starts again; switching the server version alone keeps the current values.
For a service installed before env-file support, run `t3 service install` once
with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default T3 home, `chmod 600 ~/.t3/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so T3 Code starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported. To keep a Windows host available
through T3 Connect, leave the desktop app running with its local environment
enabled, or keep `t3 serve` running in a terminal. Minimize the desktop app rather
than closing its last window, which stops its local server. Linking T3 Connect
does not configure automatic startup at Windows sign-in.

`t3 up` installs the service when you set up T3 Connect, but the two are managed
separately. Signing out of T3 Connect does not stop or uninstall the service.

## Keep the server responsive when agents use all memory

On Linux, agents already run with lower priority than the server. When they
fill the machine's memory, though, the kernel may still slow down or stop the
server, because only an administrator can reserve memory for it. Run, as your
normal user:

```sh
t3 service protect
```

It shows the system settings it will change, asks before applying them, and
then asks for your sudo password. If the machine runs Tailscale or SSH, it
also offers to protect them, so you can still reach the machine. Memory
protection takes effect at once. The server's protection from the kernel's
out-of-memory killer takes effect after `t3 service restart`. `t3 service status` reports whether
the protection is in place, and `t3 service protect --undo` removes it.

## Troubleshooting

Start with `t3 service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running T3 Code as root creates a separate installation and Connect
identity. Without administrator access, run `t3 serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status t3code.service`, then use the repair command printed by T3 Code.                     |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `t3 service restart`.                            |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `t3` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.

For failures after signing in to T3 Connect, see
[connection troubleshooting](./t3-connect-troubleshooting.md).

## Reclaim database space

T3 Code removes internal history older than a day on its own while it runs;
your conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Maintenance (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

When the desktop app or the background service runs T3 Code on that machine,
select **Reclaim** in Settings on web or desktop. T3 Code checks for free disk
space, then stops, repairs the database, and starts again. It is offline while
the repair runs, and running agents stop. If the repair fails, Settings shows
why.

In other cases, such as a server you started by hand, run `t3 doctor` on the
machine that hosts the environment. It reports the database size and the
space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use. Use `--base-dir` for a
different data directory.

The repair can take several minutes on a large database. It rebuilds the
database through a temporary copy, so it needs free space of about twice the
data still in use (the database size minus the reclaimable space): once in the
system temporary directory (on Linux and macOS, `TMPDIR`, or `/var/tmp` when it
is not set) and once next to the database for its write-ahead log.

If you upgraded from a version before 0.1.0, its database (`state.sqlite`) is
still kept next to the current one so you can roll back. `t3 doctor` offers to
delete it, but never selects that repair for you and `--fix` skips it: once it
is gone, a version before 0.1.0 starts with no threads or settings.
