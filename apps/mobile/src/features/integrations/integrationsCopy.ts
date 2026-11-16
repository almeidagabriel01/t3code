import { integrationCategoryLabel } from "@t3tools/client-runtime/integrations";
import { IntegrationCategory } from "@t3tools/contracts";

/** The Integrations page's fixed section titles; Settings search reads these same strings. */
export const INTEGRATIONS_SECTION_TITLE = {
  connected: "Connected",
  available: "Available",
  other: "Other",
} as const;

export const INTEGRATIONS_PAGE_LABELS: readonly string[] = [
  ...Object.values(INTEGRATIONS_SECTION_TITLE),
  ...[null, ...IntegrationCategory.literals].map(integrationCategoryLabel),
  // How its rows connect: MCP servers that sign in with OAuth or a token.
  "sign in",
  "oauth",
  "mcp",
  "token",
];
