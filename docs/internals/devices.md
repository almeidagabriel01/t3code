# Devices

The environment server owns simulators, emulators and connected physical devices the way it owns
terminals: discovery, streaming, and agent access all run there, and every
client reaches them through the environment connection. This is what makes the
Device panel work over Tailscale and T3 Connect, including when an SSH host runs the devices.

## Two external tools, one seam

[expo-device-hub](../../apps/server/src/device/LocalDeviceHost.ts) streams and
[agent-device](../../apps/server/src/device/AgentDeviceShim.ts) drives. Each is
npm-installed at a pinned version into the T3 home after its matching Device
panel consent step. Manual setup installs and starts only expo-device-hub;
agent-device remains absent and stopped until agent access is granted. Both run
with the server's Node; `npx` would make the first `device_open` after a reboot
depend on the registry. The hub is a supervised child rather than an imported
middleware because serve-sim loads private CoreSimulator frameworks through a
native addon, and a crash there must not take the server down.

Everything platform-specific sits behind
[`DeviceHost`](../../apps/server/src/device/DeviceHost.ts). The service lists,
boots, and shuts down devices through the host's device operations, and the
proxy and the MCP tools only see a hub origin and an agent-device endpoint.
Hosts that run expo-device-hub share one hub-backed implementation of those
operations, so a host whose devices live elsewhere only replaces them.
SSH hosts forward both endpoints to server loopback. Every proxied request
also carries the host id; device ids alone are not unique across hosts.

## EAS Simulator hosts are billed sessions

An [EAS host](../../apps/server/src/device/EasDeviceHost.ts) has no machine:
each opened device is an EAS Simulator session that bills the Expo account
until it stops. Every session is created with the host's run and idle limits,
the host refuses to start past its session limit, and closing the host stops
its sessions. Sessions it starts are recorded under the state directory and
stopped by the next server if this one dies; sessions other tools started on
the same account are never touched.

Each session brings its own preview host (serve-sim, or serve-emu for Android)
and agent-device daemon, with their own tokens. The proxy asks the host to
route each request (`DeviceHostReady.upstream`) and adds the session token server-side, so
clients never hold it. Agent config files are written per device
(`DeviceOperations.agentEndpoint`), which is why `device_open` opens the
device before targeting it. Device settings and tools run `simctl` or `adb` on
the device's machine, which EAS does not expose, so they are unavailable there.

## Simlock hosts lease through the agent-device front

A [Simlock host](../../apps/server/src/device/SimlockDeviceHost.ts) (alpha) opens a
device by running T3's own agent-device CLI against the gateway's agent-device
front (`connect proxy`, then `open`), not with Simlock's lease HTTP API:
agent-device cannot adopt a lease it did not allocate. The lease is bound to
that one agent-device session and to the directory `open` ran in, so
`agentEndpoint` hands every thread the same session, a `stateDir` holding its
connection record, and no `--udid`/`--serial` (the gateway refuses selectors).
Installs work only from that directory; `device_open` names it.

Simlock serves a lease's screen and input to its holder in serve-sim's formats
on both platforms: AVCC envelopes at `/v1/leases/<id>/stream` and serve-sim's
input messages at `/v1/leases/<id>/input`, both with the agent token. Clients
therefore treat a Simlock Android lease like iOS (`serveSimOnly` in the stream
client), and `upstream` maps serve-sim's `stream.avcc` and `helper/ws` paths to
those routes. Simlock has no MJPEG, screenshot, or host command routes, so the
panel offers only input there.
Leases are renewed while tracked and released at the host's age limit; one a
crashed server left behind ends on its own one TTL later, so there is no ledger.

## USB iPhones and this computer stream from capture sources

Neither has a hub. [`CaptureDevices`](../../apps/server/src/device/CaptureDevices.ts)
lists them on the local host and runs at most one capture per device, shared by
every viewer. A capture serves serve-sim's AVCC envelopes on loopback, so the
proxy and the viewer treat it as one more serve-sim upstream, routed before the
hub's readiness check because no hub is behind it. A capture is video only:
there is no input socket, so it serves the frame size at `/config`, and the
viewer reads it again on each new description.

- **Mac**: [`t3-device-capture`](../../native/device-capture) captures a USB
  iPhone or a display and encodes with VideoToolbox
  ([`MacVideoCapture`](../../apps/server/src/device/MacVideoCapture.ts)). A USB
  iPhone is an AVFoundation capture device only in a process that sets
  `kCMIOHardwarePropertyAllowScreenCaptureDevices`, which is why ffmpeg cannot
  see it and why this is not a Node addon: the property and the capture session
  must live in the process that holds the Camera permission. Displays use
  ScreenCaptureKit and the Screen Recording permission. A still screen produces
  no frames, so the helper repeats the last frame once a second, and as a
  keyframe for each new viewer.
- **Windows and Linux**: ffmpeg grabs the desktop (gdigrab, x11grab) into
  Annex B H.264, and [`avccFramer`](../../apps/server/src/device/avccFramer.ts)
  re-frames it into the same envelopes. Wayland has no grab ffmpeg can use
  without a portal prompt, so it is an issue, not a fallback.

A user open starts the capture; an agent open never does. The last viewer
leaving arms a short linger so a reconnect does not restart the helper; close,
an `ended` event (an unplugged phone), disabling devices and server shutdown
stop it. A failed start is never cached: it shows on the device as an issue
until a start succeeds.

Readiness is a list of `issues`, each marked with what it blocks: watching,
agents driving, or both. Signing is read from settings at authorization time,
since the listing goes stale the moment the user saves a Team ID.

Agents drive a USB iPhone with agent-device's on-device runner. The daemon reads
the signing team and bundle id from its own environment when it starts, so a
signing change stops the daemon and the next command starts it with the new
values.

This computer is a device only for access and holds. Computer use passes every
acting call and snapshot through `DeviceService.authorizeAgent` for the desktop,
before asking the user to approve the action and again right before acting, so
the access policy and **Take over** decide computer use and device tools alike.
Screenshots and permission reads skip the gate. Device tools never open the
desktop.

## The hub is never exposed

serve-sim has a shell-exec route whose token is readable from its own
unauthenticated `/api`, and serve-emu's action routes have no auth at all. The
hub binds loopback and the only way in is the
[proxy](../../apps/server/src/device/DeviceHubProxy.ts), which allowlists the
stream, config, and screenshot routes and authenticates every request as an
environment session. `<img>` and `WebSocket` cannot carry headers, so the proxy
authenticates like the `/ws` upgrade: cookie, or a short-lived `wsTicket` that
bearer and DPoP clients mint over authenticated HTTP. The ticket is stripped
before the request reaches the hub.

Stream responses carry `Cache-Control: no-transform`; the compression
middleware would otherwise buffer an MJPEG body that never ends. Browsers paint an
MJPEG part only once the next part begins and the hub writes one only when the
screen changes, so the proxy
[re-sends the last part](../../apps/server/src/device/mjpegStillFrame.ts) after a
short quiet period. In browser dev, the Vite proxy must forward WebSocket
upgrades for `/api`, not only `/ws`.

## Device settings never go through the hub

serve-sim's preview drives its Tools panel by sending shell commands over that
same exec channel. Proxying it, even allowlisted, would hand any environment
session arbitrary command execution on the host, so T3 does not. The
[`device.action`](../../apps/server/src/device/DeviceActions.ts) RPC runs the
underlying `simctl`, `adb`, and serve-sim helper binaries itself through
`DeviceHostReady.run`, one typed action per control, and returns the settings
it reads back. The proxy allowlist grows only with read routes (accessibility
tree, foreground app, event log) and refuses non-GET methods everywhere except
screenshot capture and stream tuning.

## Agents drive through the CLI

The `device_*` toolkit is deliberately four tools: list, open, screenshot, and
close. Driving happens through the `agent-device` CLI, which has the semantic
snapshot model agents need and stays current with its own releases. T3 prepends
a shim directory to the provider's PATH. The CLI installs on the environment
server even when that server cannot run simulators. Hosts start on demand.

That environment is fixed when the provider subprocess spawns, so
[`prepareMcpSession`](../../apps/server/src/orchestration-v2/ProviderSessionManager.ts)
starts agent-device only when device support and agent access have both been
enabled, the session has the `device` capability, and the machine can run at
least one platform. Starting it later from `device_open` would leave the
already-running agent without the CLI.

How to drive a device is returned from `device_open`, not kept in an
always-loaded prompt or skill: it costs nothing in threads that never open a
device and cannot drift from the pinned CLI version. `device_open` returns a
launcher bound to its agent-device session, so agents need no target flags.
The launcher leaves out the flags a command refuses (`cdp` talks to Metro, not
to the device), refuses the commands that would replace T3's connection, and
checks that connection first: agent-device reports a sandboxed shell and a
dropped tunnel alike as an unreachable daemon, so the launcher names which one it
is. Ending a session (`device_close`, the Device panel, a shutdown) also closes
its agent-device session, which quits the app that session opened and releases the CLI's claim on the device.

One method, `DeviceService.authorizeAgent`, decides whether an agent may act on a
device, and `open`, `agentTarget`, `agentLauncher` and every `device_*` handler
call it. It checks, in order: the device's access policy (`deviceAccess` in
server settings; a simulator or emulator defaults to allow, a physical device to
ask), whether another thread already has a launcher bound to the device, and
whether the user holds it. The user's own opens over the WebSocket carry no agent
and skip it. `ask` needs `DecisionService`, which sits above `DeviceService` in
the layer stack, so the MCP handler passes the question in with the call; the
answer is remembered per delegation tree in memory and lost on restart.

The in-use rule is T3's, not agent-device's: the CLI runs in the agent's shell,
so the server never sees its `DEVICE_IN_USE`. Orchestration also sits above
`DeviceService`, so the MCP handler walks the caller's `subagent` parent links
and passes the ancestors in; forks end the walk. Threads in one delegation
lineage share the device, the access answer and one agent-device session, named
after the lineage's top thread, because the CLI claims a device per session and
would refuse a child with its own. That session ends when the lineage's last
thread closes. Any other thread is refused while one is open. Simlock sessions
are shared by design and exempt.

Access policies are keyed by an identity that survives boots and reconnects.
The host sets it (`DeviceSummary.identity`), because only the host knows what
lasts: hub-backed hosts name an emulator by its AVD, since its id becomes
`emulator-NNNN` once booted, and a Wi-Fi phone by its `ro.serialno`, since its
id is an address or mDNS name that changes. Everything else keeps its id (iOS
UDIDs, USB serials, cloud and leased devices, whose names can repeat). The hub
reports only adb serials, so `DeviceHubOperations` reads the serial once per
Wi-Fi connection. A policy stored under a plain id still
applies and moves to the stable key on the next change. Holds and in-use checks
stay keyed by the id the stream and launchers use.

A hold is in-memory state per host and device, set by the first input frame the
user sends through `DeviceHubProxy` or by `device.setHold`, and cleared only by
`device.setHold`; nothing times it out, and it outlives the session. A held
device refuses every agent action except a screenshot. The generated launcher
enforces the same thing for the CLI: `setHold` writes a marker file, and the
launcher's preflight prints it and exits for any command that is not read-only.
That is the ceiling: an agent that calls `agent-device` without the launcher, or
drives the device with `adb` or `simctl`, is not stopped. Closing that gap means
proxying the daemon's `/rpc` instead of handing the agent its address.

Agents choose between these tools and ssh before they open anything, so
sessions that hold `device` get a short block from
[`orchestrationInstructions.ts`](../../packages/provider-core/src/server/orchestrationInstructions.ts)
through their adapter's instruction channel. It points simulator, emulator and phone UI
work on local and SSH hosts at the tools; `simctl`, `adb` and ssh stay
available for what the tools do not cover. Pi and Muse do not send it yet.
Claude's native subagents never see the session's system prompt, so a
`SubagentStart` hook passes them the block, where the runtime runs hooks and the
subagent's context is not isolated.

## Wi-Fi pairing is adb's QR flow, driven by the server

`DeviceService.startWifiPairing` runs Android's "Pair device with QR code"
protocol through the host's `run`, so an SSH host pairs with its own adb. The
QR carries a random `ADB_WIFI_` service name and password; the server watches
`adb mdns services` for that pairing service, runs `adb pair` with the password
on stdin (never in argv, state or logs), then waits for the phone in
`adb devices` or connects to its `_adb-tls-connect` service. adb's exit codes
are unreliable here, so success is read from its output. adb auto-connects
paired phones by mDNS name, so `forgetDevice`'s `adb disconnect` may be undone
while the phone keeps Wireless debugging on.

One attempt runs per environment, held in memory; a repeat with the same
request id returns it, and another is refused. Turning device support off or
removing the host ends it. EAS and Simlock hosts have no machine running adb,
so they refuse to pair. Live status travels in
`DeviceServiceState.wifiPairing` without the password, so every client sees an
attempt but only the one that started it can show the code.

## The viewer decodes both vendored protocols

The hub vendors two streaming servers with different wire formats. iOS video is
an HTTP body of AVCC envelopes decoded with WebCodecs, with input on a separate
binary WebSocket; Android multiplexes SEMU-framed H.264 and JSON gestures over
one WebSocket. [`DeviceStreamView.tsx`](../../apps/web/src/components/device/DeviceStreamView.tsx)
speaks both so one panel covers both platforms.

WebCodecs is secure-context only, so the viewer probes `isConfigSupported` and falls back to
MJPEG on iOS when decoding is unavailable. Android's SEMU socket has no MJPEG;
there the panel reports that it cannot decode.

serve-sim can also be locked to WebRTC, as on EAS Simulator, and then refuses
AVCC with a 409 naming the transport. The viewer still asks for AVCC first, so
hubs that serve it pay nothing, and switches on that 409, or when its MJPEG
image fails in a browser that has `RTCPeerConnection`. Offers are not trickled:
serve-sim takes one offer with every candidate. The video element only feeds
the same canvas sink, so the panel and the mobile WebView keep one surface.
Android asks serve-emu's `/api` before opening its video socket and streams
WebRTC when it is advertised (EAS Simulator), keeping a separate `video=0`
socket for input so input can reconnect without restarting video.
