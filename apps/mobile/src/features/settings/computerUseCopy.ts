import {
  COMPUTER_USE_CAPABILITY_LABELS,
  COMPUTER_USE_HOST_INTRO,
  COMPUTER_USE_HOST_NOT_REPORTED,
} from "@t3tools/client-runtime/state/mac-permissions";

/** The Computer use page's fixed labels; Settings search reads these same strings. */
export const COMPUTER_USE_COPY = {
  intro:
    "What agents can do on the Windows or Linux computer that runs T3 Code, and where the platform stops them. There are no permissions to grant there.",
  thisComputer: "This computer",
  notReported: "Not reported",
} as const;

export const COMPUTER_USE_PAGE_LABELS: readonly string[] = [
  ...Object.values(COMPUTER_USE_COPY),
  COMPUTER_USE_HOST_INTRO,
  COMPUTER_USE_HOST_NOT_REPORTED,
  ...Object.values(COMPUTER_USE_CAPABILITY_LABELS),
];
