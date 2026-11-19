import type * as Electron from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { makeRotatingLogFileWriter } from "../app/DesktopObservability.ts";

export interface RendererIdentity {
  readonly surface: "main" | "preview" | "splash" | "picture-in-picture" | "devtools";
  readonly tabId?: string;
}

export class DesktopRendererHistory extends Context.Service<
  DesktopRendererHistory,
  {
    readonly register: (
      webContents: Electron.WebContents,
      identity: RendererIdentity,
    ) => Effect.Effect<void>;
    readonly recordMetrics: (metrics: ReadonlyArray<Electron.ProcessMetric>) => Effect.Effect<void>;
    readonly shutdown: Effect.Effect<void>;
  }
>()("@t3tools/desktop/telemetry/DesktopRendererHistory") {}

interface RendererMemory {
  readonly sampledAtUnixMs: number;
  // Electron reports process-wide working sets in KiB, not JavaScript heaps.
  readonly kind: "electron-process-working-set";
  readonly workingSetBytes: number;
  readonly peakWorkingSetBytes: number;
}

// A process-wide snapshot. `cpuPercent` covers the interval since the previous getAppMetrics call.
interface ProcessSummary {
  readonly type: Electron.ProcessMetric["type"];
  readonly pid: number;
  readonly cpuPercent: number;
  readonly cpuSeconds: number | null;
  readonly workingSetBytes: number;
}

interface RecordHeader {
  readonly version: 1;
  readonly mainPid: number;
  readonly mainSessionStartedAtUnixMs: number;
  readonly timestampUnixMs: number;
}

type AppRecord = RecordHeader &
  (
    | { readonly event: "gpu-sample"; readonly gpu: ProcessSummary }
    | {
        readonly event: "child-process-gone";
        readonly processType: Electron.Details["type"];
        readonly reason: Electron.Details["reason"];
        readonly exitCode?: number;
      }
  );

interface RendererRecord {
  readonly version: 1;
  readonly mainPid: number;
  readonly mainSessionStartedAtUnixMs: number;
  readonly timestampUnixMs: number;
  readonly event:
    | "created"
    | "identified"
    | "dom-ready"
    | "sample"
    | "render-process-gone"
    | "unresponsive"
    | "unresponsive-stack"
    | "responsive"
    | "destroyed";
  readonly webContentsId: number;
  readonly surface: RendererIdentity["surface"];
  readonly tabId?: string;
  readonly rendererPid: number | null;
  readonly rendererPidSource: "current" | "last-known" | "unavailable";
  readonly rendererCreationTimeMs: number | null;
  readonly memory: RendererMemory | null;
  readonly reason?: Electron.RenderProcessGoneDetails["reason"];
  readonly exitCode?: number;
  readonly processes?: ReadonlyArray<ProcessSummary>;
  readonly jsStackStatus?: "collected" | "unavailable" | "timeout" | "failed";
  readonly jsStack?: string;
  // A V8 interrupt answers only while script runs, so a late stack may come from later work.
  readonly jsStackWaitMs?: number;
}

type HistoryRecord = RendererRecord | AppRecord;

interface TrackedRenderer {
  readonly webContents: Electron.WebContents;
  identity: RendererIdentity;
  pid: number | null;
  creationTimeMs: number | null;
  memory: RendererMemory | null;
  gone: boolean;
  collectingStack: boolean;
  readonly removeListeners: () => void;
}

const nonnegative = (value: number): number | null =>
  Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

// A stack the frame never reports (no JavaScript running) must not hold the episode open.
const JS_STACK_TIMEOUT = Duration.seconds(5);
const JS_STACK_MAX_CHARS = 4_096;

const summarizeProcess = (metric: Electron.ProcessMetric): ProcessSummary => ({
  type: metric.type,
  pid: metric.pid,
  cpuPercent: Math.round(nonnegative(metric.cpu.percentCPUUsage * 10) ?? 0) / 10,
  cpuSeconds:
    metric.cpu.cumulativeCPUUsage === undefined ? null : nonnegative(metric.cpu.cumulativeCPUUsage),
  workingSetBytes: nonnegative(metric.memory.workingSetSize * 1024) ?? 0,
});

const make = Effect.fn("DesktopRendererHistory.make")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const path = yield* Path.Path;
  const electronApp = yield* ElectronApp.ElectronApp;
  const clock = yield* Clock.Clock;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const mainSessionStartedAtUnixMs = clock.currentTimeMillisUnsafe();
  const records = yield* Queue.sliding<HistoryRecord>(256);
  const active = new Map<number, TrackedRenderer>();
  let accepting = true;
  const writer = yield* makeRotatingLogFileWriter({
    filePath: path.join(environment.logDir, "renderer-history.ndjson"),
    maxBytes: 256 * 1024,
    maxFiles: 2,
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Renderer incident history could not be opened.").pipe(
        Effect.as({ writeText: (_chunk: string) => Effect.void }),
      ),
    ),
  );

  const writeRecord = (record: HistoryRecord) =>
    writer.writeText(`${JSON.stringify(record)}\n`).pipe(Effect.ignore);
  const writerFiber = yield* Effect.forever(
    Effect.uninterruptibleMask((restore) =>
      restore(Queue.take(records)).pipe(Effect.flatMap(writeRecord)),
    ).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.void,
      ),
    ),
  ).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        while (Queue.sizeUnsafe(records) > 0) {
          const pending = yield* Queue.takeAll(records);
          yield* Effect.forEach(pending, writeRecord, { discard: true });
        }
      }),
    ),
    Effect.forkScoped,
  );

  const readPid = (renderer: TrackedRenderer): RendererRecord["rendererPidSource"] => {
    try {
      if (!renderer.gone && !renderer.webContents.isDestroyed()) {
        const pid = renderer.webContents.getOSProcessId();
        if (Number.isInteger(pid) && pid > 0) {
          if (pid !== renderer.pid) {
            renderer.pid = pid;
            renderer.creationTimeMs = null;
            renderer.memory = null;
          }
          return "current";
        }
      }
    } catch {
      // Electron can remove a guest before its destruction callback runs.
    }
    return renderer.pid === null ? "unavailable" : "last-known";
  };
  const header = (): RecordHeader => ({
    version: 1,
    mainPid: process.pid,
    mainSessionStartedAtUnixMs,
    timestampUnixMs: clock.currentTimeMillisUnsafe(),
  });
  const record = (
    renderer: TrackedRenderer,
    event: RendererRecord["event"],
    details?: Electron.RenderProcessGoneDetails,
    diagnostics?: Pick<RendererRecord, "processes" | "jsStackStatus" | "jsStack" | "jsStackWaitMs">,
  ): void => {
    const rendererPidSource = readPid(renderer);
    Queue.offerUnsafe(records, {
      ...header(),
      event,
      webContentsId: renderer.webContents.id,
      ...renderer.identity,
      rendererPid: renderer.pid,
      rendererPidSource,
      rendererCreationTimeMs: renderer.creationTimeMs,
      memory: renderer.memory,
      ...(details === undefined
        ? {}
        : {
            reason: details.reason,
            ...(Number.isFinite(details.exitCode)
              ? { exitCode: Math.round(details.exitCode) }
              : {}),
          }),
      ...diagnostics,
    });
  };

  type StackDiagnostics = Pick<RendererRecord, "jsStackStatus" | "jsStack">;
  const readStack = (renderer: TrackedRenderer) =>
    Effect.tryPromise({
      try: () =>
        renderer.webContents.mainFrame.collectJavaScriptCallStack() as Promise<string | void>,
      catch: () => "failed" as const,
    }).pipe(
      Effect.map((stack): StackDiagnostics =>
        typeof stack === "string"
          ? { jsStackStatus: "collected", jsStack: stack.slice(0, JS_STACK_MAX_CHARS) }
          : { jsStackStatus: "unavailable" },
      ),
      Effect.timeoutOption(JS_STACK_TIMEOUT),
      Effect.map(Option.getOrElse((): StackDiagnostics => ({ jsStackStatus: "timeout" }))),
      Effect.orElseSucceed((): StackDiagnostics => ({ jsStackStatus: "failed" })),
    );
  const onRendererUnresponsive = Effect.fn("DesktopRendererHistory.onRendererUnresponsive")(
    function* (renderer: TrackedRenderer) {
      // Only the app's own window: previews hang often, carry third-party stacks, and would crowd it out.
      if (renderer.identity.surface !== "main") return record(renderer, "unresponsive");
      const processes = yield* electronApp.getAppMetrics.pipe(
        Effect.map((metrics) => metrics.map(summarizeProcess)),
        Effect.catchCause(() => Effect.undefined),
      );
      record(renderer, "unresponsive", undefined, processes === undefined ? {} : { processes });
      if (renderer.collectingStack) return;
      renderer.collectingStack = true;
      const startedAtMs = clock.currentTimeMillisUnsafe();
      const stack = yield* readStack(renderer).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            renderer.collectingStack = false;
          }),
        ),
      );
      if (accepting) {
        record(renderer, "unresponsive-stack", undefined, {
          ...stack,
          jsStackWaitMs: clock.currentTimeMillisUnsafe() - startedAtMs,
        });
      }
    },
  );

  const register = (webContents: Electron.WebContents, identity: RendererIdentity) =>
    Effect.sync(() => {
      if (!accepting || webContents.isDestroyed()) return;
      const boundedIdentity: RendererIdentity = {
        surface: identity.surface,
        ...(identity.tabId === undefined ? {} : { tabId: identity.tabId.slice(0, 128) }),
      };
      const existing = active.get(webContents.id);
      if (existing !== undefined) {
        if (
          existing.identity.surface !== boundedIdentity.surface ||
          existing.identity.tabId !== boundedIdentity.tabId
        ) {
          existing.identity = boundedIdentity;
          record(existing, "identified");
        }
        return;
      }
      const onDomReady = () => {
        if (renderer.gone) {
          renderer.pid = null;
          renderer.creationTimeMs = null;
          renderer.memory = null;
          renderer.gone = false;
        }
        record(renderer, "dom-ready");
      };
      const onDevToolsOpened = () => {
        const tools = webContents.devToolsWebContents;
        if (tools)
          runFork(
            register(tools, {
              surface: "devtools",
              ...(renderer.identity.tabId === undefined ? {} : { tabId: renderer.identity.tabId }),
            }),
          );
      };
      const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
        readPid(renderer);
        renderer.gone = true;
        record(renderer, "render-process-gone", details);
      };
      // A hung page keeps its process, so only these show when it stopped and came back.
      const onUnresponsive = () => runFork(onRendererUnresponsive(renderer));
      const onResponsive = () => record(renderer, "responsive");
      const onDestroyed = () => {
        record(renderer, "destroyed");
        active.delete(webContents.id);
        renderer.removeListeners();
      };
      const renderer: TrackedRenderer = {
        webContents,
        identity: boundedIdentity,
        pid: null,
        creationTimeMs: null,
        memory: null,
        gone: false,
        collectingStack: false,
        removeListeners: () => {
          webContents.removeListener("dom-ready", onDomReady);
          webContents.removeListener("devtools-opened", onDevToolsOpened);
          webContents.removeListener("render-process-gone", onGone);
          webContents.removeListener("unresponsive", onUnresponsive);
          webContents.removeListener("responsive", onResponsive);
          webContents.removeListener("destroyed", onDestroyed);
        },
      };
      active.set(webContents.id, renderer);
      webContents.on("dom-ready", onDomReady);
      webContents.on("devtools-opened", onDevToolsOpened);
      webContents.on("render-process-gone", onGone);
      webContents.on("unresponsive", onUnresponsive);
      webContents.on("responsive", onResponsive);
      webContents.once("destroyed", onDestroyed);
      record(renderer, "created");
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.void,
      ),
    );

  let lastSampledAtUnixMs = -Infinity;
  const recordMetrics = (metrics: ReadonlyArray<Electron.ProcessMetric>) =>
    Effect.sync(() => {
      if (!accepting) return;
      const sampledAtUnixMs = clock.currentTimeMillisUnsafe();
      if (sampledAtUnixMs - lastSampledAtUnixMs < 30_000) return;
      lastSampledAtUnixMs = sampledAtUnixMs;
      const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));
      const gpu = metrics.find((metric) => metric.type === "GPU");
      if (gpu !== undefined) {
        Queue.offerUnsafe(records, {
          ...header(),
          event: "gpu-sample",
          gpu: summarizeProcess(gpu),
        });
      }
      for (const renderer of active.values()) {
        const pidSource = readPid(renderer);
        // A last-known PID may already have been reused by another process.
        const metric =
          pidSource !== "current" || renderer.pid === null ? undefined : byPid.get(renderer.pid);
        if (metric !== undefined) {
          renderer.creationTimeMs = nonnegative(metric.creationTime);
          renderer.memory = {
            sampledAtUnixMs,
            kind: "electron-process-working-set",
            workingSetBytes: nonnegative(metric.memory.workingSetSize * 1024) ?? 0,
            peakWorkingSetBytes: nonnegative(metric.memory.peakWorkingSetSize * 1024) ?? 0,
          };
        }
        // A process can host multiple contents; these rows must not be summed.
        record(renderer, "sample");
      }
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.void,
      ),
    );
  yield* electronApp.on(
    "child-process-gone",
    (_event: Electron.Event, details: Electron.Details) => {
      if (!accepting) return;
      Queue.offerUnsafe(records, {
        ...header(),
        event: "child-process-gone",
        processType: details.type,
        reason: details.reason,
        ...(Number.isFinite(details.exitCode) ? { exitCode: Math.round(details.exitCode) } : {}),
      });
    },
  );
  const shutdown = Effect.sync(() => {
    accepting = false;
    for (const renderer of active.values()) renderer.removeListeners();
    active.clear();
  }).pipe(
    Effect.andThen(Fiber.interrupt(writerFiber)),
    Effect.asVoid,
    Effect.withSpan("desktop.rendererHistory.shutdown"),
  );
  yield* Effect.addFinalizer(() => shutdown);

  return DesktopRendererHistory.of({ register, recordMetrics, shutdown });
});

export const layer = Layer.effect(DesktopRendererHistory, make());
