import type { FollowUpBehavior } from "../../lib/followUpBehavior";

export const FOLLOW_UP_OPTIONS: ReadonlyArray<{
  readonly behavior: FollowUpBehavior;
  readonly label: string;
  readonly description: string;
}> = [
  {
    behavior: "queue",
    label: "Queue",
    description: "Your message waits and runs after the current turn finishes.",
  },
  {
    behavior: "steer",
    label: "Steer",
    description: "Your message reaches the agent right away, changing what it is working on.",
  },
];

/** The Chat page's fixed text; Settings search reads these same strings. */
export const CHAT_COPY = {
  whileRunning: "While the agent is running",
  footer: (modifier: string) =>
    `Long-press the send button to use the other option for a single message. With a hardware keyboard, hold ${modifier} while sending.`,
};

export const CHAT_PAGE_LABELS: readonly string[] = [
  CHAT_COPY.whileRunning,
  ...FOLLOW_UP_OPTIONS.flatMap(({ label, description }) => [label, description]),
  CHAT_COPY.footer("Ctrl"),
  CHAT_COPY.footer("Command"),
];
