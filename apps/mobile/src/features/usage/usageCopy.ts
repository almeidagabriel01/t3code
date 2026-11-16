/** The Usage page's fixed labels; the command palette finds the page by these same strings. */
export const USAGE_COPY = {
  views: { cost: "Cost", tokens: "Tokens", limits: "Limits" },
  providers: "Providers",
  totals: "Totals",
  metrics: {
    processedTokens: "Processed tokens",
    cacheSavings: "Cache savings",
    cachedInput: "Cached input",
    uncachedInput: "Uncached input",
    output: "Output",
    unpriced: "Unpriced",
  },
  cost: "Cost",
  byType: "By type",
  bySpeed: "By speed",
  byModel: "By model",
} as const;

export const USAGE_PAGE_LABELS: readonly string[] = [
  ...Object.values(USAGE_COPY.views),
  USAGE_COPY.providers,
  USAGE_COPY.totals,
  ...Object.values(USAGE_COPY.metrics),
  USAGE_COPY.cost,
  USAGE_COPY.byType,
  USAGE_COPY.bySpeed,
  USAGE_COPY.byModel,
  // Limits lists a row per signed-in account, and providers call those limits quotas.
  "accounts",
  "quota",
];
