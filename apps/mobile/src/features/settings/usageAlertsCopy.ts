/** The Limit alerts page's fixed labels; Settings search reads these same strings. */
export const USAGE_ALERTS_COPY = {
  title: "Limit alerts",
  intro: "Your assistant messages you once when this much is left.",
  needsNewerServer: "Limit alerts need a newer T3 Code server.",
  paused: {
    label: "Alerts are paused",
    description: "Assistant notifications are off, so limit alerts wait. Change it in Assistants.",
  },
  noLimits: "No subscription limits reported yet.",
} as const;

export const USAGE_ALERTS_PAGE_LABELS: readonly string[] = [
  USAGE_ALERTS_COPY.title,
  USAGE_ALERTS_COPY.intro,
  USAGE_ALERTS_COPY.needsNewerServer,
  USAGE_ALERTS_COPY.paused.label,
  USAGE_ALERTS_COPY.paused.description,
  USAGE_ALERTS_COPY.noLimits,
  // What users call these limits.
  "usage",
  "quota",
  "weekly",
  "session",
  "notify",
];
