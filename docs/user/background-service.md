# Running T3 Code in the background

## Desktop app at sign-in

On macOS and Windows, the desktop app starts when you sign in, so agents, the
Runner and channels come back after a restart without opening it. It starts
without a window; click its Dock icon or open T3 Code again to show one. Turn this off in
Settings → General → Open at login. If macOS shows the setting as turned off in
System Settings → Login Items, turn T3 Code on there.

## Service

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
Mac that hosts T3 Code (with the [Runner](#runner-heavy-work-on-a-linux-pc) on,
heavy commands can run on a Linux PC instead, in its own line). Agents put the command behind `t3 heavy`, and the
queue starts jobs in order. In Claude sessions T3 Code starts, heavy Bash
commands (tests, builds, type checks, `git commit` with its hooks, simulators)
go through the queue on their own, even when the agent forgets. A `git commit`
waits only when the repository has a commit hook, and then goes ahead of other
waiting jobs; without one it runs at once. Open the **Resource Manager** in the status bar:
its top bar shows each machine's CPU, free memory and slots, and a gauge turns
amber when it is what holds the queue ("memory low", "CPU busy"; hover it for
the reading). **Heavy work** lists each job once, by machine, running first and
then waiting with its place in that machine's line, with a short name (agents
give one with `--name`; otherwise T3 derives it from the command), its project
and how long it has run or waited. A waiting job says why it has not started
("swapping 40 MB/s", "needs ~4.0 GB; 4.4 GB free, 3.2 GB kept spare"). Hover a
job, or click it, for the rest: the full command, folder, thread, priority,
usage and notes. On mobile, open Settings → Maintenance → **Resource Manager**
and tap a row for the rest.

To see only one project's jobs, open **Heavy work** from a thread's right panel
(on mobile, **Project → Heavy work** in the thread menu). Waiting jobs keep their
place in the whole queue.

- **Slots.** Settings → Maintenance → **Heavy work** → **This Mac** sets how many
  jobs run at once on this Mac (default 3; 1 is strictly one at a time). The next
  job starts only when this Mac has room for what that command usually uses in
  its runs here (the same test file counts as one command), and a few seconds
  after the previous start so its real load shows first. A later job that fits
  goes ahead of one that does not fit yet; after five minutes of waiting
  (**Let smaller jobs pass for**), the job in front lets nothing pass until it starts. Simulators, emulators and the
  dev app run alone.
  Running jobs are never stopped to relieve pressure.
- **Memory pressure.** On macOS, a second job waits while the system reports
  memory pressure or is swapping heavily, whatever the free percentage says;
  memory held by running simulators and emulators counts as used. Only a
  light command (runs here stayed under 512 MB) still starts then, and not even
  that while the pressure is critical. A lone job
  always starts. Each job's test runners and build tools get as many workers as
  the machine has free cores (`T3_HEAVY_WORKERS`): Vitest, Playwright,
  `node --test`, Gradle, xcodebuild, `swift build`, cargo and `cmake --build`.
  The workers are a ceiling: a count the command sets is kept, and so is a lower
  one from Gradle's or cargo's config; CMake is limited only with Ninja or Xcode.
  `make` runs one job at a time unless you pass `-j`, so it is left as is.
- **Limits.** Settings → Maintenance → **Heavy work** → **This Mac** sets how
  much memory this Mac keeps free (default 20%) and its CPU limit (default 70%). A job waits
  while the CPU limit is crossed; below the memory floor only a light command starts. After memory pressure or swapping held the queue, memory must recover 5 points past the floor
  before the next one starts. A job's usage includes the build daemons it uses,
  such as Gradle's, so the queue learns what a build really costs.
- **Job sizing.** The **Job sizing** group under **Heavy work** sets what counts
  as light (default 512 MB), what a command with no runs here is taken to need
  (1.5 GB for builds and suites, 0.5 GB for lint, typecheck and single test
  files), how many commands keep their past runs (1000), and how long smaller
  jobs may pass the first in line (5 minutes).
- **Slow down agent jobs when the Mac is busy.** On macOS, once this Mac stays
  over its CPU limit for **Over the limit for**, agents' running jobs and the
  build daemons they use drop to background CPU priority. They return to normal
  once the Mac would stay under the limit with them at full speed for that long.
  Your own jobs, jobs whose priority you changed and jobs started with the queue
  off keep their speed. It is on by default; turn it off under **This Mac**.
- **Reorder.** Drag a waiting job, or use its **⋯** menu: **Run next**, **Move
  up**, **Move down**, **Move to end**, **Open thread**, **Remove**. A running
  job's menu has **Stop**, which ends its `t3 heavy` command.
- **Priority per project.** In the same menu, set **Always first** or **Last**
  for the job's project. New jobs from that project go ahead of, or behind,
  normal ones; jobs already queued and jobs you moved by hand keep their place.
  Settings → Maintenance → **Heavy work** lists the rules so you can remove them.
- **Priority per job.** Commands you run in T3 Code's terminal go ahead of the
  ones agents queue. **Start now** or **High priority now** in a job's menu
  starts a waiting job right away on the machine it was headed for, this Mac or
  Linux, skipping only that machine's wait; if Linux is offline, the job follows
  **When Linux is offline**. Agents ask for it with `t3 heavy --priority high`,
  or `t3 heavy --now`. On macOS,
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
- **Pause.** The pause button in the **Heavy work** header (also in Settings) stops anything new from
  starting while running jobs finish. A pause icon appears in the status bar.
- **Off.** Settings → Maintenance → **Heavy work** → **Heavy work queue** turns
  the queue off. Every heavy job then starts right away, jobs that were waiting
  included (unless the Runner sends it to Linux), and agents stop asking whether to run now or queue on this Mac; work bound for Linux still asks while Linux is offline or full. Use it when the
  machine has power to spare, or when you would rather have everything run at
  once than wait. The Resource Manager still lists what is running. The slot
  limit, the pause and the priority rules keep their values and apply again
  when you turn the queue back on; jobs already running are not stopped.

**Heavy work** in the Resource Manager (on mobile, Settings → Server
controls) also lists heavy commands an agent or terminal started directly,
under This Mac, once their processes use at least half a core or 1 GB for a
few seconds. Each shows its project, CPU (share of the machine) and memory;
its details add its thread, cores, the peak seen since T3 started watching it,
and how long it has run. **Stop** in its menu ends the command and everything
it started. A heavy command no agent or terminal in T3 Code started, such as
tests a script runs on its own, shows under **Outside T3** with that reason in
its details: the queue cannot route it, and it has no **Stop**, since T3 Code
cannot tell what else the script is doing. The section appears only while
something heavy runs or the queue is paused or off.

Agents never reorder the queue on their own. They may move a job up only when
you ask them to in the conversation, and the job's note says an agent did it.

## Runner: heavy work on a Linux PC

Settings → Maintenance → **Runner** sends heavy jobs to a Linux PC over SSH
with `remoto` instead of this Mac. It switches on and off apart from the heavy
work queue, and each section says what the two do together.

- **Where heavy work runs.** Pick one:
  - **This Mac** keeps everything here.
  - **Mac first** fills this Mac, then sends the rest to Linux: a job goes to
    Linux once this Mac has **Send to Linux after** jobs running or waiting
    (default 4), or sooner when this Mac is full and Linux can start it now.
  - **Hybrid** splits jobs between both: each goes to the machine with the
    shorter queue per slot (this Mac on a tie), and neither starts a job past
    its own limits. While Linux is offline everything stays here.
  - **Linux** sends every heavy command there, except work with one of the
    reasons below to stay on this Mac.

  With the queue off, work starts here at once and Hybrid or Mac first send it
  to Linux only while this Mac is over its limits. All of these, and the
  policies below, can be set per project; the PC's SSH host, slots, limits and
  checks apply to the whole machine.

- **Linux limits.** Linux takes a job while a slot is free, no other job from
  the same worktree runs there, and it stays under its own **Keep memory free**
  (default 20%) and **CPU limit** (default 70%). It starts at most one new job
  per heartbeat, and waits about a minute after each start so that job's load
  shows first. A busy Linux is not offline: jobs wait for it and say why
  ("waiting for Linux: 1.8 GB free, keeping 20%").
- **Over the limit for.** Either machine counts as over its limits, or back
  under them, only once its readings stay there this long (default 20
  seconds), so a short spike never moves work.
- **What goes to Linux.** A line such as
  `cd apps/web && vp test run > out.log 2>&1; tail out.log` runs in this Mac's
  shell as written. Only its heavy commands (`vp`, `pnpm`, `vitest`, `tsc` and
  the like, even inside scripts and git hooks) go to Linux, each from the folder
  the line is in at that point and with its paths and variables already
  expanded; redirects, pipes, `cd`, read-only git and everything else run here.
  On Linux, the project's own tools (`vp`, `vitest`) come first, from
  `node_modules/.bin` between the command's folder and the checkout.
- **Why work stays on this Mac.** A heavy command stays here only for one of
  these reasons, which its row, its card and the agent's output show with what
  caused it:
  - **Mac-only tool**: Xcode and simulator tools, `adb`, `open`, `pbcopy`,
    `hyperfine` and the rest of the Runner's Mac-only tools list, plus
    `expo run`, `expo prebuild` and `playwright install`.
  - **Builds native code for this Mac**: native toolchains such as
    `cargo build` or `cargo test`, `go build` or `go test`, `swift`, `make`,
    `cmake`, `clang`, `gcc` and `codesign`. Linux would build binaries this Mac
    can't run, and skip its macOS-only code.
  - **Uses a file only this Mac has**: an argument, or a variable set for the
    command (`T3CODE_HOME=~/.t3/dev vp test run`, `env`, `export`), names a
    path outside the project, such as `~/.t3`, `~/Library` or another checkout.
  - **Changes this Mac's checkout**: git commands that write (commits run here,
    since the pre-commit hook edits this Mac's repository) and installs.
  - **Pinned to this Mac**: it matches **Always on this Mac**, or it was started
    with `t3 heavy --runner mac`.
  - **Serves a port used here**: dev servers such as `vite`, `next dev`,
    `expo start`, a `dev`, `start` or `serve` script or `turbo`/`nx` task, or a
    test runner's `--ui`.
  - **Watches this Mac's files**: `--watch`, or `-w` on a test runner or `tsc`.
    On Linux it would watch a copy your edits never reach.
  - **Uses this Mac's Docker**: `docker` and `podman` commands, whose images
    and containers live in this Mac's daemon.
  - **Talks to a port open here**: an argument or variable names `localhost`,
    `127.0.0.1` or `::1` with a port something on this Mac listens on, such as
    `--base-url http://localhost:5733`.

  A tenth reason is learned: **Linux couldn't run this before** (see **If a
  Linux run fails**). Waiting for a slot or for a machine under its limits is
  never a reason; the row shows it separately. Simulators, emulators, device
  opens and `dev:desktop` also run here, alone, as **Always on this Mac**.

- **Asking for Linux.** A command started with `t3 heavy --runner linux` never
  runs on this Mac. If one of its commands turns out to need this Mac, the job
  ends with exit code 75 and "Asked for Linux, but it needs this Mac: <reason>".
  If Linux lacks a tool or file it needs, the job ends with Linux's exit code
  and "Linux couldn't run this: <error>", without running it here or learning
  a route. An agent's own `remoto` call is sent to Linux too, but it did not
  ask for Linux: one that needs this Mac runs here, with a note saying why.
- **When Linux is offline.** A job headed for Linux that is still waiting
  follows **Run on this Mac**, **Wait for Linux** or **Ask me**, an agent's own
  `remoto` included. A job started with `t3 heavy --runner linux` never moves
  to this Mac: where the setting would run it here, it ends with exit code 75
  and "Linux is offline and this job asked for Linux". A question
  shows on the job in the Resource Manager with a countdown; unanswered, it
  follows the deadline setting. An agent's foreground command gives up after 10
  minutes, so longer waits only help background commands.
- **If a Linux run fails.** A run the PC drops (the connection, or the PC
  restarting) goes back to Linux by itself, up to 3 attempts by default; while
  Linux is offline it follows **When Linux is offline**. Jobs going back start
  there one at a time, as **Linux limits** describes. After the last attempt,
  this setting decides. **Tell the agent** (the default) ends the job with
  Linux's error and "Linux couldn't run this: <reason>", and nothing reruns it.
  **Run on this Mac**, **Wait for Linux** and **Ask me** hand the job to this
  Mac, back to Linux, or to you instead. A command Linux lacks a tool or folder
  for runs again on this Mac by itself, whatever this setting says, unless its
  job asked for Linux (see **Asking for Linux**). Two such
  failures (by default) teach the route for a while; `t3 heavy routes` lists what it
  learned and `t3 heavy routes --forget <key|all>` clears it. When Linux runs
  very short of memory with several jobs, it stops the newest one and queues it
  again; that is not a failure. A command that fails on Linux for its own
  reasons, such as a failing test, returns its exit code and output unchanged
  and never reruns.
- **Bring results back.** On by default. The files a Linux command created or
  changed come back to this Mac when it ends, whether it passed or failed, with
  their file modes, except names in **Never bring back** (`node_modules`,
  `.git`, `.turbo`, `*.tsbuildinfo` and native build output such as `target`,
  `.build` and `DerivedData` by default). A file you changed here
  during the job is left alone, a file the command deleted on Linux stays here,
  and a run whose results come to more than **Bring back up to** (200 MB)
  copies nothing back. The job's card says what stayed on Linux.
- **Moving jobs.** A job's **⋯** menu has **Run on this Mac** and **Run on
  Linux**. Moving a running job stops it and starts it again on the other side.
  A job Linux dropped runs again only once Linux confirms the earlier run
  stopped; if the PC cannot be reached, the menu asks before running it twice.
  **Move all to Linux** and **Move all to this Mac**, on each machine's header
  in the Resource Manager (on mobile too, and for agents through the heavy-work
  tool), move every waiting job there at once. Running jobs, jobs that must stay
  on this Mac and jobs queued for this Mac by hand stay where they are. Each
  shows only when at least one job would move, so Move all to Linux is hidden
  while Linux is offline.
- **Status.** The Resource Manager shows whether Linux is online, its jobs, load
  and free memory, and on each job where it runs and whether it is syncing,
  installing dependencies or running.
- A job canceled because nobody answered in time exits with code 75, the code
  `remoto` uses when the PC is down.
- **Notices.** T3 Code shows a toast when a heavy job fails (on this Mac or
  Linux, including a failed sync or dependency install), cannot start, is
  canceled by a deadline, waits far longer than usual because its machine stays
  over its limits, or when Linux drops a job, goes offline or comes back. Jobs
  that end up on another machine than the one they were bound for also show,
  with the reason. Several jobs at once share one toast; tap it to open the
  job's thread or the Resource Manager. Choose which ones show in Settings →
  Maintenance → **Heavy job notices**: **Problems and unexpected moves** (the
  default), **Every machine change** (adds Hybrid sending a job to Linux),
  **Problems only** or **Off**.

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

**Summarize old tool output** (Settings > Maintenance, off by default; 30 days
when you turn it on) replaces detailed tool output older than that, such as
file contents and command output, with a one-line summary. Messages stay. The
summary cannot be undone. The freed space returns to disk through the repair below.

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
