import type { PullRequestRoutingPermission } from "@t3tools/client-runtime/connection";

export const PULL_REQUEST_ROUTING_OPTIONS: ReadonlyArray<{
  value: PullRequestRoutingPermission;
  label: string;
  description: string;
}> = [
  { value: "off", label: "Off", description: "Keep source control requests on this environment." },
  {
    value: "read",
    label: "Read PRs",
    description: "Share PR data with other enabled environments.",
  },
  {
    value: "read-write",
    label: "Read and act",
    description:
      "Actions may use broader source control permissions than the original environment.",
  },
];

/** The Environments page's fixed text; Settings search reads these same strings. */
export const ENVIRONMENTS_COPY = {
  cloudHeader: "T3 Connect",
  pullRequestRouting: {
    title: "Pull request routing",
    footer:
      "Choose environments you trust to share PR data and use each other's source control access. Enable both environments. This applies only to this client.",
  },
} as const;

export const ENVIRONMENTS_PAGE_LABELS: readonly string[] = [
  ENVIRONMENTS_COPY.cloudHeader,
  ...Object.values(ENVIRONMENTS_COPY.pullRequestRouting),
  ...PULL_REQUEST_ROUTING_OPTIONS.flatMap(({ label, description }) => [label, description]),
  // Adding one pairs a server; its routes (Tailscale, LAN, relay) show per environment.
  "servers",
  "connections",
  "pair",
  "add environment",
  "remote",
  "tailscale",
];
