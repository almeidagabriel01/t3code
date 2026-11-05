import {
  ComputerUseError,
  type ComputerUseOpenSettingsInput,
  type DecisionId,
  type MacPermissionStatus,
  type MacPermissions,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DecisionService from "../decisions/DecisionService.ts";
import * as ProcessRunner from "../processRunner.ts";

/** One call waits this long for the user; the decision itself lives longer, so a repeat rejoins it. */
const APPROVAL_WAIT = "2 minutes";
const DECISION_EXPIRES_IN_MINUTES = 30;
const COMMAND_TIMEOUT = "15 seconds";
const MAX_TYPED_CHARS = 2_000;
const MAX_TARGET_CHARS = 200;
const MAX_COORDINATE = 20_000;
const MIN_PNG_BYTES = 1_024;

const PANE_URLS = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
} as const;

/** Values reach these scripts only as `argv`, never spliced into the source. */
const PERMISSIONS_SCRIPT = `ObjC.import('CoreGraphics'); ObjC.import('ApplicationServices');
function run(argv) {
  let automation = 'unknown';
  if (argv[0] === 'automation') {
    try { Application('System Events').processes.length; automation = 'granted'; }
    catch (error) { automation = String(error).includes('-1743') ? 'denied' : 'unknown'; }
  }
  return JSON.stringify({
    screenRecording: $.CGPreflightScreenCaptureAccess() ? 'granted' : 'denied',
    accessibility: $.AXIsProcessTrusted() ? 'granted' : 'denied',
    automation,
  });
}`;

const FRONTMOST_SCRIPT = `function run() {
  const front = Application('System Events').processes.whose({ frontmost: true });
  return front.length > 0 ? front[0].name() : '';
}`;

const SCREEN_SIZE_SCRIPT = `ObjC.import('AppKit');
function run() { const f = $.NSScreen.mainScreen.frame; return Math.round(f.size.width) + ' ' + Math.round(f.size.height); }`;

const CLICK_SCRIPT = `ObjC.import('CoreGraphics');
function run(argv) {
  const point = $.CGPointMake(Number(argv[0]), Number(argv[1]));
  const right = argv[2] === 'right';
  const [down, up, button] = right
    ? [$.kCGEventRightMouseDown, $.kCGEventRightMouseUp, $.kCGMouseButtonRight]
    : [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGMouseButtonLeft];
  const post = (type, count) => {
    const event = $.CGEventCreateMouseEvent($(), type, point, button);
    $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, count);
    $.CGEventPost($.kCGHIDEventTap, event);
  };
  post($.kCGEventMouseMoved, 0);
  for (let count = 1; count <= Number(argv[3]); count++) { post(down, count); post(up, count); }
  return 'ok';
}`;

const KEY_SCRIPT = `function run(argv) {
  const events = Application('System Events');
  const using = argv.slice(2).map((modifier) => modifier + ' down');
  if (argv[0] === 'code') events.keyCode(Number(argv[1]), { using });
  else events.keystroke(argv[1], { using });
  return 'ok';
}`;

const KEY_CODES: Readonly<Record<string, number>> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  delete: 51,
  forwarddelete: 117,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};
const MODIFIERS: ReadonlyArray<string> = ["command", "shift", "option", "control"];

export interface ComputerUseCaller {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadTitle: string;
}

/** `clientRequestId` makes a repeat land on the same decision; omitted, it derives from the arguments. */
export interface ClickInput {
  /** What the user is shown beside the coordinates, so they never approve blind. */
  readonly target: string;
  readonly x: number;
  readonly y: number;
  readonly button?: "left" | "right" | undefined;
  readonly double?: boolean | undefined;
  readonly clientRequestId?: string | undefined;
}
export interface TypeInput {
  readonly target: string;
  readonly text: string;
  readonly clientRequestId?: string | undefined;
}
export interface KeyInput {
  readonly target: string;
  readonly key: string;
  readonly modifiers?: ReadonlyArray<string> | undefined;
  readonly clientRequestId?: string | undefined;
}

export interface ScreenshotResult {
  readonly png: Uint8Array;
  /** The image is resized to the screen's size in points, so image pixels are click coordinates. */
  readonly width: number;
  readonly height: number;
}

export class ComputerUse extends Context.Service<
  ComputerUse,
  {
    /**
     * Never fails: off macOS it reports `supported: false`. Reading Automation can make macOS
     * prompt, so it is only read when asked; otherwise it is `unknown`.
     */
    readonly permissions: (options: {
      readonly automation: boolean;
    }) => Effect.Effect<MacPermissions>;
    readonly openSettings: (
      input: ComputerUseOpenSettingsInput,
    ) => Effect.Effect<void, ComputerUseError>;
    /** Read-only, needs no approval. */
    readonly screenshot: Effect.Effect<ScreenshotResult, ComputerUseError>;
    /** Click, type and key ask the user first and act at most once per approved decision. */
    readonly click: (
      caller: ComputerUseCaller,
      input: ClickInput,
    ) => Effect.Effect<void, ComputerUseError>;
    readonly type: (
      caller: ComputerUseCaller,
      input: TypeInput,
    ) => Effect.Effect<void, ComputerUseError>;
    readonly key: (
      caller: ComputerUseCaller,
      input: KeyInput,
    ) => Effect.Effect<void, ComputerUseError>;
  }
>()("t3/computerUse/ComputerUse") {}

const fail = (reason: ComputerUseError["reason"], detail?: string) =>
  new ComputerUseError({ reason, ...(detail === undefined ? {} : { detail }) });
const failed = (cause: unknown) => new ComputerUseError({ reason: "failed", cause });

const status = (value: unknown): MacPermissionStatus =>
  value === "granted" || value === "denied" ? value : "unknown";

/** Reads the JSON the permissions script prints; anything else is `unknown`, never a guess. */
export const parsePermissions = (stdout: string): MacPermissions => {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    // Unreadable output stays `unknown`.
  }
  return {
    supported: true,
    screenRecording: status(parsed.screenRecording),
    accessibility: status(parsed.accessibility),
    automation: status(parsed.automation),
  };
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Digest.Digest;
  const decisions = yield* DecisionService.DecisionService;

  /** A repeat of the same action derives the same id, so it lands on the same decision. */
  const idFor = Effect.fn("ComputerUse.idFor")(function* (
    action: string,
    parts: ReadonlyArray<string | number>,
  ) {
    const digest = yield* crypto
      .digest(Digest.sha256, new TextEncoder().encode(parts.join("\u0000")))
      .pipe(Effect.mapError(failed));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `computer:${action}:${hex.slice(0, 32)}`;
  });

  const requireMac =
    platform === "darwin" ? Effect.void : Effect.fail(fail("unsupported_platform"));

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: COMMAND_TIMEOUT }).pipe(
      Effect.mapError(failed),
      Effect.flatMap((output) =>
        output.code === 0 && !output.timedOut
          ? Effect.succeed(output.stdout)
          : Effect.fail(
              fail("failed", `The Mac action failed (exit code ${output.code ?? "none"}).`),
            ),
      ),
    );
  const jxa = (script: string, args: ReadonlyArray<string> = []) =>
    run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, ...args]);

  const permissions: ComputerUse["Service"]["permissions"] = Effect.fn("ComputerUse.permissions")(
    function* (options) {
      if (platform !== "darwin") {
        return {
          supported: false,
          screenRecording: "unknown",
          accessibility: "unknown",
          automation: "unknown",
        } as const;
      }
      return yield* jxa(PERMISSIONS_SCRIPT, options.automation ? ["automation"] : []).pipe(
        Effect.map(parsePermissions),
        Effect.orElseSucceed(() => parsePermissions("")),
      );
    },
  );

  const openSettings: ComputerUse["Service"]["openSettings"] = Effect.fn(
    "ComputerUse.openSettings",
  )(function* (input) {
    yield* requireMac;
    yield* run("/usr/bin/open", [PANE_URLS[input.pane]]);
  });

  const screenshot: ComputerUse["Service"]["screenshot"] = Effect.gen(function* () {
    yield* requireMac;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-computer-" })
          .pipe(Effect.mapError(failed));
        const file = `${directory}/screen.png`;
        yield* run("/usr/sbin/screencapture", ["-x", "-t", "png", file]);
        const [width, height] = (yield* jxa(SCREEN_SIZE_SCRIPT)).trim().split(" ").map(Number);
        if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)) {
          return yield* fail("failed", "Could not read the screen size.");
        }
        yield* run("/usr/bin/sips", ["-z", String(height), String(width), file]);
        const png = yield* fs.readFile(file).pipe(Effect.mapError(failed));
        // Without the permission macOS can hand back an empty or wallpaper-only capture, however
        // large, so the permission decides; a tiny file is blank whatever macOS says.
        const { screenRecording } = yield* permissions({ automation: false });
        if (screenRecording === "denied" || png.byteLength < MIN_PNG_BYTES) {
          return yield* fail("screen_recording_missing");
        }
        return { png, width, height };
      }),
    );
  }).pipe(Effect.withSpan("ComputerUse.screenshot"));

  /** The settled decision, or undefined when the user has not answered within the wait. */
  const waitForAnswer = Effect.fn("ComputerUse.waitForAnswer")(function* (decisionId: DecisionId) {
    const current = yield* decisions.get(decisionId);
    if (current.status !== "open") return current;
    const settled = yield* decisions.subscribe.pipe(
      Stream.map((event) =>
        event.type === "snapshot"
          ? event.decisions.find((decision) => decision.id === decisionId)
          : event.decision.id === decisionId
            ? event.decision
            : undefined,
      ),
      Stream.filter((found) => found !== undefined && found.status !== "open"),
      Stream.runHead,
      Effect.timeoutOption(APPROVAL_WAIT),
    );
    return Option.flatten(settled).pipe(Option.getOrUndefined);
  }, Effect.mapError(failed));

  /** Asks, waits, and runs `act` only for a decision answered "Approve" that has not run yet. */
  const approved = Effect.fn("ComputerUse.approved")(function* <A>(
    caller: ComputerUseCaller,
    request: {
      readonly clientRequestId: string;
      readonly title: string;
      readonly context: string;
    },
    act: Effect.Effect<A, ComputerUseError>,
  ) {
    const decision = yield* decisions
      .request({
        fromThreadId: caller.threadId,
        projectId: caller.projectId,
        threadTitle: caller.threadTitle,
        clientRequestId: request.clientRequestId,
        title: clip(request.title, 120),
        context: request.context,
        options: [
          { id: "accept", label: "Approve", consequence: "The agent acts on your Mac once" },
          { id: "deny", label: "Deny", consequence: "Nothing happens" },
        ],
        recommended: "deny",
        expiresInMinutes: DECISION_EXPIRES_IN_MINUTES,
      })
      .pipe(Effect.mapError(failed));
    const settled = yield* waitForAnswer(decision.id);
    if (settled === undefined) {
      return yield* fail(
        "approval_pending",
        "Still waiting for the user to approve this action. Call again with the same arguments to keep waiting; do not act another way.",
      );
    }
    if (settled.status !== "answered" || settled.answer?.optionId !== "accept") {
      return yield* fail("not_approved");
    }
    // Stored on the decision, so a restart cannot run an approved action a second time.
    const claimed = yield* decisions.claimExecution(decision.id).pipe(Effect.mapError(failed));
    if (!claimed) {
      return yield* fail(
        "already_executed",
        "This approved action already ran once. Pass a new clientRequestId to do it again, which asks the user again.",
      );
    }
    // A failed action releases the approval so the same decision can be retried.
    return yield* act.pipe(
      Effect.tapError(() => Effect.ignore(decisions.releaseExecution(decision.id))),
    );
  });

  /** Checks the permissions the action needs and returns them. Automation is read for every action. */
  const ready = Effect.fn("ComputerUse.ready")(function* (needAutomation: boolean) {
    yield* requireMac;
    const current = yield* permissions({ automation: true });
    if (current.accessibility === "denied") return yield* fail("accessibility_missing");
    if (needAutomation && current.automation === "denied") {
      return yield* fail(
        "accessibility_missing",
        "T3 Code is not allowed to control System Events (Automation permission). Ask the user to grant it in Settings > Mac permissions, then try again.",
      );
    }
    return current;
  });

  /** The app in front, read through System Events only when macOS already allows it. */
  const frontmostApp = Effect.fn("ComputerUse.frontmostApp")(function* (current: MacPermissions) {
    if (current.automation !== "granted") return undefined;
    const name = yield* jxa(FRONTMOST_SCRIPT).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.orElseSucceed(() => ""),
    );
    return name === "" ? undefined : name;
  });

  /** What the user reads before approving: what the agent says it is doing, then the exact action. */
  const describe = Effect.fn("ComputerUse.describe")(function* (
    current: MacPermissions,
    target: string,
    summary: string,
    action: string,
    detail = "",
  ) {
    const app = yield* frontmostApp(current);
    return {
      title: `${clip(target, 60)}: ${summary}`,
      context: [
        `**Target:** ${target}`,
        `**Action:** ${action}`,
        ...(app === undefined ? [] : [`**App in front:** ${app}`]),
        ...(detail === "" ? [] : ["", detail]),
      ].join("\n"),
    };
  });

  const checkTarget = (input: { readonly target: string }) => {
    const target = input.target.trim();
    return target === "" || target.length > MAX_TARGET_CHARS
      ? Effect.fail(
          fail(
            "invalid",
            `target must be 1-${MAX_TARGET_CHARS} characters: say what you are acting on, such as "the blue Save button in System Settings".`,
          ),
        )
      : Effect.succeed(target);
  };

  const click: ComputerUse["Service"]["click"] = Effect.fn("ComputerUse.click")(
    function* (caller, input) {
      const target = yield* checkTarget(input);
      const { x, y } = input;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x > MAX_COORDINATE ||
        y > MAX_COORDINATE
      ) {
        return yield* fail(
          "invalid",
          "x and y must be non-negative screen coordinates from the screenshot.",
        );
      }
      const point = { x: Math.round(x), y: Math.round(y) };
      const button = input.button ?? "left";
      const count = input.double === true ? 2 : 1;
      const current = yield* ready(false);
      const verb = count === 2 ? "double-click" : "click";
      const summary = `${verb} at (${point.x}, ${point.y})`;
      return yield* approved(
        caller,
        {
          clientRequestId:
            input.clientRequestId?.trim() ||
            (yield* idFor("click", [point.x, point.y, button, count])),
          ...(yield* describe(
            current,
            target,
            summary,
            `${button}-${verb} at **(${point.x}, ${point.y})** on your Mac's main screen.`,
          )),
        },
        jxa(CLICK_SCRIPT, [String(point.x), String(point.y), button, String(count)]).pipe(
          Effect.asVoid,
        ),
      );
    },
  );

  const type: ComputerUse["Service"]["type"] = Effect.fn("ComputerUse.type")(
    function* (caller, input) {
      const target = yield* checkTarget(input);
      if (input.text === "" || input.text.length > MAX_TYPED_CHARS) {
        return yield* fail("invalid", `text must be 1-${MAX_TYPED_CHARS} characters.`);
      }
      const current = yield* ready(true);
      return yield* approved(
        caller,
        {
          clientRequestId: input.clientRequestId?.trim() || (yield* idFor("type", [input.text])),
          ...(yield* describe(
            current,
            target,
            `type "${clip(input.text.replaceAll("\n", " "), 30)}" (${input.text.length} chars)`,
            `type ${input.text.length} characters into whatever is focused:`,
            `\`\`\`\n${input.text.replaceAll("```", "'''")}\n\`\`\``,
          )),
        },
        jxa(KEY_SCRIPT, ["text", input.text]).pipe(Effect.asVoid),
      );
    },
  );

  const key: ComputerUse["Service"]["key"] = Effect.fn("ComputerUse.key")(
    function* (caller, input) {
      const target = yield* checkTarget(input);
      const name = input.key.trim();
      const lower = name.toLowerCase();
      const code = KEY_CODES[lower];
      const modifiers = (input.modifiers ?? []).map((modifier) => modifier.trim().toLowerCase());
      if (
        name === "" ||
        (code === undefined && [...name].length !== 1) ||
        !modifiers.every((modifier) => MODIFIERS.includes(modifier))
      ) {
        return yield* fail(
          "invalid",
          `key must be one character or one of: ${Object.keys(KEY_CODES).join(", ")}; modifiers any of: ${MODIFIERS.join(", ")}.`,
        );
      }
      const sorted = [...new Set(modifiers)].sort();
      const keyName = code === undefined ? name : lower;
      const label = [...sorted, keyName].join("+");
      const current = yield* ready(true);
      return yield* approved(
        caller,
        {
          clientRequestId:
            input.clientRequestId?.trim() || (yield* idFor("key", [keyName, ...sorted])),
          ...(yield* describe(current, target, `press ${label}`, `press **${label}**.`)),
        },
        jxa(
          KEY_SCRIPT,
          code === undefined ? ["text", name, ...sorted] : ["code", String(code), ...sorted],
        ).pipe(Effect.asVoid),
      );
    },
  );

  return ComputerUse.of({ permissions, openSettings, screenshot, click, type, key });
});

export const layer = Layer.effect(ComputerUse, make);
