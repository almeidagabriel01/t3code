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

export const IPHONE_SIGNING_COPY = {
  title: "iPhone signing",
  intro:
    "Agents need your Apple Team ID to sign the on-device runner that drives a USB iPhone. The first run asks you to trust the developer profile on the phone (Settings > General > VPN & Device Management) and to turn on Developer Mode.",
  teamId: "Apple Team ID",
  bundleId: "Runner bundle id (optional)",
} as const;

export const WIFI_PAIRING_COPY = {
  title: "Phone over Wi-Fi",
  footer: "Pair an Android phone on the same Wi-Fi network as the computer running T3 Code.",
  connect: "Connect a phone over Wi-Fi",
} as const;

export const DEVICES_PAGE_LABELS: readonly string[] = [
  ...Object.values(DEVICES_COPY),
  ...Object.values(IPHONE_SIGNING_COPY),
  ...Object.values(WIFI_PAIRING_COPY),
  ...Object.values(DEVICE_ACCESS_POLICY_LABELS).flatMap(({ label, description }) => [
    label,
    description,
  ]),
];
