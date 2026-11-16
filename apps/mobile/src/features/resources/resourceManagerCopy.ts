import type { ResourceSort } from "@t3tools/client-runtime/state/resourceTree";

/** The Resource Manager's fixed headings and sort options. */
export const RESOURCE_MANAGER_COPY = {
  sort: { title: "Sort" },
  heavyWork: { title: "Heavy work" },
  devices: { title: "Devices" },
  t3Code: { title: "T3 Code" },
  outsideT3: { title: "Outside T3" },
  other: { title: "Other" },
} as const;

export const RESOURCE_SORT_LABEL: Record<ResourceSort, string> = {
  name: "Name",
  cpu: "CPU",
  memory: "Memory",
};

export const RESOURCE_MANAGER_LABELS: readonly string[] = [
  ...Object.values(RESOURCE_MANAGER_COPY).map(({ title }) => title),
  ...Object.values(RESOURCE_SORT_LABEL),
  // Its rows are processes, and Heavy work lists the heavy queue by machine (Mac or Linux).
  "processes",
  "queue",
  "linux",
];
