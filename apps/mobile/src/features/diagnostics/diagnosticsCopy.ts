/** The Diagnostics page's fixed text; Settings search reads these same strings. */
export const DIAGNOSTICS_COPY = {
  crashReports: {
    title: "Crash reports",
    send: "Send crash reports",
    footer:
      "When the app crashes or hits an error, it sends the error message, the stack trace, the app version, and the device model and OS version to the T3 Code team. Each launch also sends startup timings. Reports carry a random ID for this install.",
  },
  startupCrashes: { title: "Startup crashes" },
  actions: {
    title: "Actions",
    footer:
      "Paste the report into a GitHub issue. It contains the app version, the JavaScript error message, and the component stack. Error messages can quote values from the app, so read it over before sharing.",
  },
} as const;

export const DIAGNOSTICS_PAGE_LABELS: readonly string[] = Object.values(DIAGNOSTICS_COPY).flatMap(
  (group) => Object.values(group),
);
