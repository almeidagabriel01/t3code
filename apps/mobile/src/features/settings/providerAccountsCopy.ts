import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";

/** A provider row's name: the server's, else the driver catalog's, so search knows it too. */
export const providerName = (provider: Pick<ServerProvider, "displayName" | "driver">) =>
  provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;

/** The Providers page's fixed labels, including its Claude in Chrome subpage; Settings search reads these same strings. */
export const PROVIDER_ACCOUNTS_COPY = {
  limitedPermissions: "Limited permissions",
  claudeChrome: "Claude in Chrome",
  addClaudeAccountDescription:
    "Use a Claude config folder that is already signed in on this server.",
} as const;

export const CLAUDE_CHROME_COPY = {
  intro:
    "Lets Claude use your Chrome: open pages, click, fill forms, read the console and network.",
  enabledByDefault: {
    title: "Enabled by default",
    description: "New Claude sessions for this account start with the browser tools.",
  },
  sharedConfig: "Shared by every Claude account that has no Claude home of its own.",
  extension: "Extension",
  links: {
    install: "Install extension",
    reconnect: "Reconnect extension",
    permissions: "Manage site permissions",
  },
} as const;

export const PROVIDERS_PAGE_LABELS: readonly string[] = [
  ...Object.values(PROVIDER_ACCOUNTS_COPY),
  CLAUDE_CHROME_COPY.intro,
  CLAUDE_CHROME_COPY.enabledByDefault.title,
  CLAUDE_CHROME_COPY.enabledByDefault.description,
  CLAUDE_CHROME_COPY.sharedConfig,
  CLAUDE_CHROME_COPY.extension,
  ...Object.values(CLAUDE_CHROME_COPY.links),
  ...Object.values(PROVIDER_DISPLAY_NAMES).flatMap((name) => (name === undefined ? [] : [name])),
  // The page's old name, and what users call signing a provider in.
  "provider accounts",
  "login",
  "auth",
];
