// @effect-diagnostics nodeBuiltinImport:off -- the fixed osascript process needs Node child events.
import * as NodeChildProcess from "node:child_process";
import * as NodeTimers from "node:timers";

import * as DateTime from "effect/DateTime";

export type ImessageSendFailure = {
  /** `not_sent` when Messages certainly did not take it, `unknown` when it may have. */
  readonly outcome: "not_sent" | "unknown";
  readonly code:
    | "automation_denied"
    | "messages_not_signed_in"
    | "chat_not_found"
    | "timeout"
    | "unknown";
};

export interface ImessageSender {
  readonly sendText: (input: {
    readonly chatGuid: string;
    readonly text: string;
  }) => Promise<{ readonly acceptedAt: string } | ImessageSendFailure>;
}

/**
 * Fixed script: the chat, the text and the handle arrive as arguments, never spliced into the
 * source. A chat that also carries SMS sends by SMS, so a 1:1 reply goes to the handle on the
 * iMessage account; the chat id is the fallback.
 */
export const IMESSAGE_SCRIPT = `on run argv
  set targetID to item 1 of argv
  set messageText to item 2 of argv
  set targetHandle to item 3 of argv
  tell application "Messages"
    set targetParticipant to missing value
    if targetHandle is not "" then
      try
        set targetParticipant to participant targetHandle of (1st account whose service type = iMessage)
      end try
    end if
    if targetParticipant is missing value then
      send messageText to (get chat id targetID)
    else
      send messageText to targetParticipant
    end if
  end tell
end run
`;

/** The other person's handle in a 1:1 chat guid such as `any;-;+15550000000`; empty otherwise. */
const directHandle = (chatGuid: string) => /^[^;]+;-;([^;]+)$/.exec(chatGuid)?.[1] ?? "";

/** What osascript says when Messages has no account to send from. */
const NOT_SIGNED_IN = /not signed in|isn.t signed in|no (?:imessage )?account/i;

export function makeOsascriptImessageSender(
  input: {
    readonly timeoutMs?: number;
    readonly spawnProcess?: typeof NodeChildProcess.spawn;
  } = {},
): ImessageSender {
  return {
    sendText: ({ chatGuid, text }) =>
      new Promise((resolve) => {
        if (!chatGuid.trim() || !text.trim()) {
          resolve({ outcome: "not_sent", code: "unknown" });
          return;
        }
        let child: NodeChildProcess.ChildProcessWithoutNullStreams;
        try {
          child = (input.spawnProcess ?? NodeChildProcess.spawn)(
            "/usr/bin/osascript",
            ["-l", "AppleScript", "-", chatGuid, text, directHandle(chatGuid)],
            { shell: false, stdio: ["pipe", "pipe", "pipe"] },
          ) as NodeChildProcess.ChildProcessWithoutNullStreams;
        } catch {
          resolve({ outcome: "not_sent", code: "unknown" });
          return;
        }
        let done = false;
        let started = false;
        let stderr = "";
        const finish = (result: { readonly acceptedAt: string } | ImessageSendFailure) => {
          if (done) return;
          done = true;
          NodeTimers.clearTimeout(timer);
          resolve(result);
        };
        // @effect-diagnostics-next-line globalTimers:off -- this Promise owns one spawned process and clears its timer on completion.
        const timer = NodeTimers.setTimeout(() => {
          finish({ outcome: "unknown", code: "timeout" });
          try {
            child.kill();
          } catch {
            // The send outcome is already ambiguous; process termination is best effort.
          }
        }, input.timeoutMs ?? 15_000);
        child.once("spawn", () => {
          started = true;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4096);
        });
        child.stdout.on("data", () => {});
        child.stdin.once("error", () =>
          finish({ outcome: started ? "unknown" : "not_sent", code: "unknown" }),
        );
        child.once("error", () =>
          finish({ outcome: started ? "unknown" : "not_sent", code: "unknown" }),
        );
        child.once("close", (code) => {
          if (done) return;
          if (code === 0) {
            finish({ acceptedAt: DateTime.formatIso(DateTime.nowUnsafe()) });
          } else if (/\(-1743\)/.test(stderr)) {
            finish({ outcome: "not_sent", code: "automation_denied" });
          } else if (NOT_SIGNED_IN.test(stderr)) {
            finish({ outcome: "not_sent", code: "messages_not_signed_in" });
          } else if (/\(-1728\)/.test(stderr)) {
            finish({ outcome: "not_sent", code: "chat_not_found" });
          } else {
            // The script fails before `send` completes, so a plain error is safe to retry.
            finish({ outcome: "not_sent", code: "unknown" });
          }
        });
        child.stdin.end(IMESSAGE_SCRIPT);
      }),
  };
}
