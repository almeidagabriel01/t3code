import type { ComposerEnterBehavior } from "../../lib/composerEnterBehavior";

export const enterBehaviorOptions = (
  modifier: string,
): ReadonlyArray<{
  readonly behavior: ComposerEnterBehavior;
  readonly label: string;
  readonly description: string;
}> => [
  {
    behavior: "send",
    label: "Send message",
    description: "Return sends the message. Shift-Return inserts a new line.",
  },
  {
    behavior: "newline",
    label: "Insert new line",
    description: `Return inserts a new line. ${modifier}-Return sends the message.`,
  },
];

/** The Keyboard page's fixed text; Settings search reads these same strings. */
export const KEYBOARD_COPY = {
  returnKey: "Return key",
  footer: "Applies to the composer when a hardware keyboard is connected.",
};

export const KEYBOARD_PAGE_LABELS: readonly string[] = [
  KEYBOARD_COPY.returnKey,
  ...["Ctrl", "Command"].flatMap((modifier) =>
    enterBehaviorOptions(modifier).flatMap(({ label, description }) => [label, description]),
  ),
  KEYBOARD_COPY.footer,
];
