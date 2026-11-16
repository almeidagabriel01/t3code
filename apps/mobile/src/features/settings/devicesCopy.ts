import { DEVICE_ACCESS_POLICY_LABELS } from "@t3tools/contracts";

/** The Devices page's fixed labels; Settings search reads these same strings. */
export const DEVICES_COPY = {
  intro:
    "Choose which simulators, emulators and physical devices agents may use. Simulators and emulators are allowed by default; a physical device asks first.",
  access: "Device access",
  requests: "Device requests",
  linkedClients: "Linked environments using devices here",
  linkedClientsFooter: "A blocked environment cannot list, watch or drive any device here.",
} as const;

export const DEVICES_PAGE_LABELS: readonly string[] = [
  ...Object.values(DEVICES_COPY),
  ...Object.values(DEVICE_ACCESS_POLICY_LABELS).flatMap(({ label, description }) => [
    label,
    description,
  ]),
];
