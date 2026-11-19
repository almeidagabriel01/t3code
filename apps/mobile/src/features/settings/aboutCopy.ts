import { DIAGNOSTICS_PAGE_LABELS } from "../diagnostics/diagnosticsCopy";

/** The About page's fixed labels; Settings search reads these same strings. */
export const ABOUT_COPY = {
  app: "App",
  version: "Version",
  clientStorage: "Client Storage",
  diagnostics: "Diagnostics",
  openSourceLicenses: "Open source licenses",
  legal: "Legal",
} as const;

export const CLIENT_STORAGE_COPY = {
  environmentCaches: "Environment caches",
  actions: "Actions",
  footer:
    "Clearing caches never removes environment connections, credentials, account data, or appearance preferences.",
} as const;

export const ABOUT_PAGE_LABELS: readonly string[] = [
  ...Object.values(ABOUT_COPY),
  ...Object.values(CLIENT_STORAGE_COPY),
  ...DIAGNOSTICS_PAGE_LABELS,
  // The documents its Legal page opens.
  "privacy",
  "terms",
];
