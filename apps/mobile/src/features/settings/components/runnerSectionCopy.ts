/** The Runner section's own headings; the settings' titles and descriptions come from the web. */
export const RUNNER_SECTION_COPY = {
  runner: { title: "Runner" },
  whereJobsRun: { title: "Where jobs run" },
  linuxPc: { title: "Linux PC", description: "These apply to every project on this environment." },
  linuxUnavailable: { title: "If Linux is unavailable" },
  connectionChecks: {
    title: "Connection checks",
    description: "How this Mac checks that Linux is reachable.",
    show: "Show connection checks",
    hide: "Hide connection checks",
  },
} as const;
