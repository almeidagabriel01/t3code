// @effect-diagnostics globalTimers:off - Gestures and typing are batched in web and WebView clients, outside an Effect runtime.
import type { DeviceUserInput } from "@t3tools/contracts";

/** Movement below this share of the frame, on both axes, is a tap. */
const TAP_SLOP = 0.02;
const MIN_SWIPE_MS = 16;
const MAX_SWIPE_MS = 10_000;
/** Typing is sent as one `type` command once the keys pause, since each command is a runner round trip. */
const TEXT_IDLE_MS = 400;
/** The contract's limit for one text input. */
const MAX_TEXT_LENGTH = 2_000;

type Send = (input: DeviceUserInput) => void;

/**
 * Turns one pointer's begin/move/end, in normalized frame coordinates, into the single tap or
 * swipe a USB iPhone receives: its runner takes whole gestures, not a live touch stream.
 */
export function createPhoneGesture(send: Send, now: () => number = () => performance.now()) {
  let start: { x: number; y: number; at: number } | null = null;
  return {
    touch(phase: "begin" | "move" | "end", x: number, y: number) {
      if (phase === "begin") start = { x, y, at: now() };
      if (phase !== "end" || !start) return;
      const from = start;
      start = null;
      if (Math.abs(x - from.x) < TAP_SLOP && Math.abs(y - from.y) < TAP_SLOP) {
        send({ type: "tap", x: from.x, y: from.y });
        return;
      }
      const elapsed = Math.round(now() - from.at);
      send({
        type: "swipe",
        x: from.x,
        y: from.y,
        toX: x,
        toY: y,
        durationMs: Math.min(MAX_SWIPE_MS, Math.max(MIN_SWIPE_MS, elapsed)),
      });
    },
  };
}

/** The text a key adds, or null for keys the phone's `type` command cannot carry. */
export function phoneKeyText(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}) {
  if (event.metaKey || event.ctrlKey) return null;
  if (event.key === "Enter") return "\n";
  if (event.key === "Backspace") return "\b";
  return event.key.length === 1 ? event.key : null;
}

/** Collects typed keys and pasted text, and sends them as one text input once typing pauses. */
export function createPhoneTextBuffer(send: Send) {
  let buffered = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const text = buffered;
    buffered = "";
    for (let index = 0; index < text.length; index += MAX_TEXT_LENGTH)
      send({ type: "text", text: text.slice(index, index + MAX_TEXT_LENGTH) });
  };
  return {
    add(text: string) {
      buffered += text;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, TEXT_IDLE_MS);
    },
    flush,
  };
}

export interface PhoneInputState {
  readonly pending: boolean;
  /** The last input's failure, cleared by the next one that lands. */
  readonly error: string | null;
}

/** Sends inputs one at a time and in order, reporting whether one is in flight. */
export function createPhoneInputSender(
  run: (input: DeviceUserInput) => Promise<string | null>,
  onState: (state: PhoneInputState) => void,
) {
  let tail = Promise.resolve();
  let inFlight = 0;
  let error: string | null = null;
  return (input: DeviceUserInput) => {
    inFlight += 1;
    onState({ pending: true, error });
    tail = tail.then(async () => {
      error = await run(input).catch((cause: unknown) =>
        cause instanceof Error ? cause.message : "The phone did not take the input.",
      );
      inFlight -= 1;
      onState({ pending: inFlight > 0, error });
    });
  };
}
