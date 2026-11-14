# Devices

The Device panel shows a live iOS Simulator, Android Emulator or connected
physical device next to a thread, so you can watch an agent verify mobile work
and tap the device yourself. Physical devices are listed apart and marked
**Physical**; T3 Code does not turn them on or off. Agents get the same device through `device_*` tools and the
`agent-device` command line, which T3 Code sets up for them.

## Open a device

Open the right panel in a project thread and choose **Device**. On first use,
the panel walks through three steps: starting the device hub, checking iOS and
Android support, and choosing whether agents may control devices. Opening the
panel alone does not download or start anything. If the hub is already
installed, the setup screen says so and reuses it.

Choose a running device to watch it, or choose **Start** next to a stopped
device to boot it. The panel shows when you or an agent starts a device.
Each device opens in its own tab. Use **+ → Device** to open another, and
double-click a tab name or choose **Rename** from its context menu to rename it.
Only the visible tab streams video; switching tabs keeps both devices running.
Choose **Float device over chat** in the toolbar to keep watching and tapping the
device in a small window while the right panel shows something else; drag the
window by its handle, resize it from any edge, and use **Open in right panel**
to bring it back.
Turn off **Use devices** in **Settings → Devices** to stop the
helper processes; simulators and emulators keep running until you power them
off.

Simulators run on the machine that hosts the environment server. iOS needs
macOS with Xcode. Android needs the SDK Platform-Tools, Android Emulator,
and Command-line Tools (latest), plus a virtual device created in Android
Studio's Device Manager. T3 Code detects standard SDK locations; set
`ANDROID_HOME` for a custom location. The panel explains missing dependencies.
After installing SDK tools, restart the environment server and refresh devices.

Android emulator video also needs `ffmpeg` with the libx264 encoder on the device
host's PATH, or an executable selected by `SERVE_EMU_FFMPEG` on that host. If
opening an emulator reports an ffmpeg problem, install or fix the executable
and retry opening it. After changing PATH or `SERVE_EMU_FFMPEG`, restart the
environment server for local devices, or turn device support off and on for SSH
devices, so the running tools inherit the new environment. Physical Android
devices and iOS do not need ffmpeg.

The screen is interactive: click and drag to touch, type while the screen is
focused, and use the toolbar for Home, Back, and Recents on Android, rotate on
iOS, and power off. Close the tab to stop watching; the device keeps running
unless you power it off. Closed tabs stay closed after a reload. To watch the
device again, choose it from **+ → Device**.

Choose **3D view** to inspect supported devices while the live screen stays
interactive. On iPhone Duo, use the fold and stance controls to change its
physical pose, or pinch over the device to adjust the hinge. Turning the model
to the other screen switches the live display and touch input to that screen.
**Restore 3D view** returns the device to a screen-facing position.
On supported Android foldables, use **Fold device** and **Unfold device** beside
the screen to change its posture in either view.

## Tools

The toolbar's **Tools** button opens a drawer for the open device. It shows the
foreground app, and lets you switch light and dark mode, change text size,
flip accessibility settings, overlay the accessibility element frames on the
screen, set a fake location, and grant or revoke app permissions. iOS also
exposes Liquid Glass, color filters, VoiceOver, and sending a test push
notification; Android adds orientation and toggling the network. The drawer
only shows what the platform can do, and every control reflects the value read
back from the device after a change.

## Agents and devices

When an agent opens a device, it floats over the chat in web and desktop clients
connected to the thread, the same way an agent-driven browser does. Turn off
**Auto-show floating preview** in **Settings → Browser** to open a
right-panel tab instead. In the mobile app, open the agent's thread and tap the
device button above the composer to watch the live screen and control it.
On iOS layouts with an inspector, the device opens beside the thread. Maximize
it to fill the screen; closing the full-screen view returns to the inspector.
If the thread has several devices open, choose one in the viewer. Closing the
viewer stops streaming and leaves the device available to the agent. Device
activity also appears in the thread timeline.

Agents drive the device through the `agent-device` command line. T3
Code installs and starts it only after **Agents can use devices** is on. iOS
taps build a small test runner on first use, which takes a couple of minutes
once per server. Restart an existing agent session after granting access so it
receives the device CLI environment.

### Take over from an agent

Touching the device in the panel takes it over: the agent's device commands are
refused until you hand it back, and the agent is told to wait instead of
retrying. You can also press **Take over** before you touch anything. The panel
shows that you are in control; press **Hand back** when you are done. Nothing
hands the device back for you, so an agent stays paused on it until you do. The
agent can still take screenshots while you drive. In the mobile app, **Take
over** and **Hand back** are in the device viewer's options menu.

### Choose which devices agents may use

**Settings → Devices → Device access** lists every device attached to this
environment's machines with one choice each. A linked environment's devices
follow the choices made on that environment.

- **Allow**: agents open and drive it. The default for simulators and emulators.
- **Ask first**: each thread asks you once before it uses the device. The
  default for physical devices.
- **Never**: agents cannot use it.

Reset a row to return it to its default. A thread you declined stays declined;
set the device to **Allow** to let it in. A thread and the tasks it delegates
share one answer and one device. Only one piece of work drives a device at a
time: an unrelated thread is told which thread has it. A choice stays with the
device when an emulator boots or a Wi-Fi phone reconnects.

To keep agents away from every device, turn off **Agents can use devices** in
**Settings → Devices**. This hides the device tools from agents
started from then on; your own Device panel is unaffected.

## Physical Android phones

Over USB, turn on **USB debugging** in the phone's **Developer options**, plug
it into the machine that hosts the environment server, and accept the prompt on
the phone. It appears under **Physical devices** marked **USB**.

To connect without a cable, the phone needs Android 11 or later and the same
Wi-Fi network as that machine. Choose **Connect a phone over Wi-Fi** in the
Device panel or in **Settings → Devices**, then on the phone open **Developer
options → Wireless debugging → Pair device with QR code** and scan the code.
The dialog shows each step and, if pairing fails, why and how to retry. Only
one phone pairs at a time per environment. In the mobile app, the same flow is
in **Settings → Devices**; scan the code with the phone you want to connect, and
to connect the phone that shows the code, open the screen on another device.

A paired phone is listed marked **Wi-Fi**. **Forget** next to it disconnects
it. The phone may reconnect on its own while **Wireless debugging** stays on;
to stop that, turn Wireless debugging off or remove this computer from its
paired devices list on the phone.

## iPhones and iPads over USB

On a Mac, plug the iPhone or iPad into the Mac that hosts the environment
server, unlock it and tap **Trust**. It appears under **Physical devices**
marked **USB**. The Device panel shows its screen live. The first time, macOS
asks to let T3 Code use the Camera, because that is how macOS shares a phone's
screen.

Once the phone is ready for agents (below), you can drive it from the Device
panel on the web, desktop and mobile apps: tap, swipe, type with your keyboard
or paste, and use **Home** and **App switcher**. Each tap or swipe is sent whole
when you lift your finger, typing is sent when you pause, and the first input
can take a few seconds while the phone starts its helper app. Driving it takes
the phone over from agents, as **Take over** does. Until it is ready, the panel
names what is missing instead. A phone plugged into a linked environment's
computer is view only here; drive it from that environment.

A phone that is not ready says why next to it, with what to do: pair or trust
it, unlock it, turn on **Developer Mode** (**Settings → Privacy & Security** on
the phone), install Xcode on the Mac, or grant the Camera permission.

Agents drive the phone through an app they install on it, which must be signed
with your Apple developer team. Set **Settings → Devices → iPhone signing →
Apple Team ID** (find it under **Membership** in your Apple Developer account);
set **Runner bundle id** only if the default one is taken by another team. On
the first run, trust the developer profile on the phone (**Settings → General →
VPN & Device Management**). Without a Team ID you can still watch the phone,
and agents are told to ask you to set it.

## This computer's screen

The Device panel lists this computer under **This computer**. Open it to watch
its screen live; it is view only. Agents act on this computer with computer
tools, not with device tools, but the same rules apply: **Settings → Devices →
Device access** decides whether they may (by default each thread asks you
once), and **Take over** pauses every agent action on the computer except
screenshots until you press **Hand back**.

- **macOS** needs the Screen Recording permission (**Settings → Mac
  permissions**).
- **Windows and Linux** need [ffmpeg](https://ffmpeg.org/download.html) with
  the libx264 encoder on the PATH, or set `SERVE_EMU_FFMPEG` to its path. On
  Linux the screen is captured from X11; Wayland sessions are not supported.

## Remote connections

The device stream goes through the environment server, so it works over the
local network, Tailscale, and T3 Connect. Live video needs a secure page
(HTTPS or localhost); on a plain-HTTP remote origin iOS falls back to a slower
still-image stream and Android cannot show video, except on EAS Simulator.

## Devices on a linked environment

When this environment is linked to another one with more than read-only access
(see [Link another environment](./remote-access.md#link-another-environment)), the
devices plugged into that machine appear in the
Device panel under its name, with the link's state: **Connected**, **Link down**,
or why that environment refuses, such as **Devices off there**. You can watch,
take over and hand back those devices, and your agents can open and drive them
with the same `device_*` tools, without SSH. Nothing about links shows while
there are none.

The other environment stays in charge of its devices. Its access choices apply,
a device set to **Ask first** asks its user, and its user can take over a device
your agent is using. Its Device panel shows which environment and thread is
using each device. To let a linked environment's agent in, choose **Allow** on
its request in the Device panel or in **Settings → Devices**. To shut a linked
environment out of every device, choose **Block** under **Linked environments
using devices here**; this ends what it has open.

To stop listing a linked environment's devices here and offering them to your
agents, turn it off under **Devices from linked environments** in **Settings →
Devices**. The mobile app has the same controls in **Settings → Devices**.

## SSH device hosts

In Settings → Devices, choose the environments that should use
the host and choose **Add source → Machine over SSH**. Enter an SSH alias or `user@host`, with
an optional identity file and port. These resolve on the environment server,
so use the SSH configuration and keys available there. Password prompts are
not supported.

**Test connection**, in the host's menu, checks SSH, Node, npm, and platform tools without installing
anything, with a result for each selected environment. Targets that resolve to
the environment’s own machine are skipped, since its devices are already local.
The first device listing installs pinned device tools on the host.
SSH device hosts currently need macOS or Linux. To use devices on a Windows
machine, run T3 Code on that machine and connect to its environment.
Node 22 or newer and npm must be available to non-interactive SSH commands.
T3 checks common Homebrew and Android SDK locations; custom installations need
the appropriate PATH and ANDROID_HOME on the host. Android emulator video needs
`ffmpeg` with libx264 on that host; physical Android devices use scrcpy and do
not need ffmpeg.

The picker identifies devices by host when several hosts are configured.
Connections recover after interruptions. Removing a host closes its device
sessions and stops its T3 helpers when reachable; simulators keep running.

T3 provides discovery, streaming, and control. Arrange app builds,
installation, and connectivity to development servers such as Metro separately.
A simulator on another machine cannot reach Metro through your environment's
localhost without forwarding or another reachable address.

## Simlock hosts (alpha)

[Simlock](https://incubator.callstack.com/simlock/) pools iOS simulators and
Android emulators across machines. If you run a Simlock gateway, T3 can lease
devices from it. Simlock is new and unreleased, so this integration is an
alpha: it may change or stop working with a newer Simlock. T3 does not install
or manage Simlock; set up the gateway and its workers yourself. It needs a
gateway and workers built from Simlock's `main` at
[6316e10](https://github.com/callstackincubator/simlock/commit/6316e10) or
later, the first with a lease holder's screen and input.

Turn on **Settings → Labs → Simlock device hosts (alpha)** and **Use devices**
in Settings → Devices, then choose **Add source → Simlock pool** with an **agent token**
(`simlock --gateway token create --role agent`). Give each T3 server its own
token: Simlock counts every lease made with one token against the same
requester, and allows one at a time unless the gateway's
`lease.maxPerRequester` is raised to the host's **Devices at once**. The token
leases devices and reaches only its own leases, but commands on a leased device
run on its worker, so treat it like shell access to your workers. T3 sends it
with every request, so use an HTTPS gateway URL, or plain HTTP only over an
encrypted network such as Tailscale. The gateway
and workers need `capabilities.stream.enabled` and `capabilities.input.enabled`
for the live screen and for input.

The picker lists the models your workers can make. Opening one takes a lease;
closing it with **Return device to the pool**, or removing the host, returns it
wiped. The panel keeps a watched device leased up to the host's lease limit.
You can tap, swipe, type, and press Home, and Back and Recents on Android.
Rotation, appearance, text size, device tools, and screenshots are not offered
for Simlock devices; agents can still do them through `device_open`. On iOS 27
simulators, typing on your keyboard does nothing; tap the on-screen keyboard
instead. Workers must run the same agent-device
version as T3 (see Device tool updates), and agent-device accepts app installs
for a lease only from the folder it was opened from, which `device_open`
names. A device cannot reach development servers on your machine through
localhost; use an address its worker can reach.

## Device tool updates

The connected T3 server manages the device hub and agent tools on its own machine and configured SSH hosts. Required versions install automatically the next time those tools are used. In Settings → Devices, select a version and choose **Check versions** to read installed versions without installing tools or starting devices.

If agent tools on this computer stop responding, Settings → Devices shows them as not responding, and T3 restarts them the next time they are needed. While device sessions are still open, T3 leaves them running instead, so the open sessions are not lost: close those sessions, then try again.

To receive newer tool versions on a remote environment, update that environment's T3 server. Updating only the browser or mobile app does not update the remote server. An offline host keeps its installed files, but an update needs network access before device support can start; T3 does not fall back to an older version. Reconnect the host and use Retry if installation fails. Existing device and agent-access settings are preserved.
