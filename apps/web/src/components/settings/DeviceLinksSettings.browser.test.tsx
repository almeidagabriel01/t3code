import { EnvironmentId, type DeviceServiceState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { DeviceLinksSettings } from "./DeviceLinksSettings";
import "~/index.css";

type Result = { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown };
const mocks = vi.hoisted(() => ({
  setBlocked: vi.fn<(request: unknown) => Promise<Result>>(),
  update: vi.fn<(request: unknown) => Promise<Result>>(),
  answer: vi.fn<(request: unknown) => Promise<Result>>(),
  toast: vi.fn(),
  canWrite: true,
  links: new Map<string, string>(),
}));
vi.mock("~/state/device", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  const permission = () => (mocks.canWrite ? allowed : denied);
  return {
    deviceEnvironment: {
      setLinkBlocked: { name: "block", permissionAtom: permission },
      answerLinkRequest: { name: "answer", permissionAtom: permission },
    },
  };
});
vi.mock("~/state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    ...(await importOriginal<typeof import("~/state/server")>()),
    serverEnvironment: {
      updateSettings: { name: "update", permissionAtom: () => (mocks.canWrite ? allowed : denied) },
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { name: "block" | "update" | "answer" }) =>
    ({ block: mocks.setBlocked, update: mocks.update, answer: mocks.answer })[command.name],
}));
vi.mock("~/state/peerLinks", () => ({ useLinkedEnvironments: () => mocks.links }));
vi.mock("~/state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/query")>()),
  formatEnvironmentQueryError: () => "Denied there",
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const environmentId = EnvironmentId.make("environment-a");
const state: DeviceServiceState = {
  hosts: [
    {
      id: "linked.env-studio",
      kind: "linked",
      label: "Studio Mac",
      environmentId: "env-studio",
      linkState: "connected",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [
    {
      hostId: "linked.env-studio",
      id: "R5CX",
      name: "Galaxy",
      platform: "android",
      version: "Android 16",
      booted: true,
      physical: true,
    },
  ],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
  supportsLinkedDevices: true,
};

function setup(canWrite = true) {
  vi.resetAllMocks();
  mocks.canWrite = canWrite;
  mocks.links = new Map([
    ["env-studio", "Studio Mac"],
    ["env-attic", "Attic PC"],
  ]);
  for (const command of [mocks.setBlocked, mocks.update, mocks.answer])
    command.mockResolvedValue({ _tag: "Success", value: {} });
}

describe("DeviceLinksSettings", () => {
  it("shows nothing without links, requests or linked users", async () => {
    setup();
    mocks.links = new Map();
    await using screen = await render(
      <DeviceLinksSettings environmentId={environmentId} state={state} hiddenSources={[]} />,
    );
    expect(screen.container.textContent).toBe("");
  });

  it("hides a linked environment's devices and shows them again", async () => {
    setup();
    await using screen = await render(
      <DeviceLinksSettings
        environmentId={environmentId}
        state={state}
        hiddenSources={["env-attic"]}
      />,
    );

    await expect.element(screen.getByText("1 device")).toBeInTheDocument();
    await expect
      .element(screen.getByText("Hidden: its devices are not listed here or offered to agents."))
      .toBeInTheDocument();
    await screen.getByRole("switch", { name: "List devices from Studio Mac" }).click();
    await screen.getByRole("switch", { name: "List devices from Attic PC" }).click();

    expect(mocks.update.mock.calls).toEqual([
      [
        {
          environmentId,
          input: { patch: { hiddenLinkedDeviceSources: ["env-attic", "env-studio"] } },
        },
      ],
      [{ environmentId, input: { patch: { hiddenLinkedDeviceSources: [] } } }],
    ]);
  });

  it("blocks a linked environment using devices here, lets it back in, and reports a refusal", async () => {
    setup();
    mocks.setBlocked.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("no") });
    mocks.links = new Map();
    await using screen = await render(
      <DeviceLinksSettings
        environmentId={environmentId}
        state={{
          ...state,
          linkClients: [
            { linkId: "link-1", label: "Laptop", blocked: false },
            { linkId: "link-2", label: "Desk", blocked: true },
          ],
        }}
        hiddenSources={[]}
      />,
    );

    await screen.getByRole("button", { name: "Block" }).click();
    await screen.getByRole("button", { name: "Let back in" }).click();

    expect(mocks.setBlocked.mock.calls).toEqual([
      [{ environmentId, input: { linkId: "link-1", label: "Laptop", blocked: true } }],
      [{ environmentId, input: { linkId: "link-2", label: "Desk", blocked: false } }],
    ]);
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "error",
        title: "Could not change Laptop's access",
        description: "Denied there",
      }),
    );
  });

  it("lists link requests, and every control is off without the settings grant", async () => {
    setup(false);
    await using screen = await render(
      <DeviceLinksSettings
        environmentId={environmentId}
        state={{
          ...state,
          linkRequests: [
            {
              requestId: "r-1",
              linkLabel: "Laptop",
              hostId: "local",
              deviceId: "phone",
              deviceName: "Phone",
            },
          ],
          linkClients: [{ linkId: "link-1", label: "Laptop", blocked: false }],
        }}
        hiddenSources={[]}
      />,
    );

    await expect.element(screen.getByText("Laptop wants to use Phone.")).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Block" })).toBeDisabled();
    await expect
      .element(screen.getByRole("switch", { name: "List devices from Studio Mac" }))
      .toBeDisabled();
  });
});
