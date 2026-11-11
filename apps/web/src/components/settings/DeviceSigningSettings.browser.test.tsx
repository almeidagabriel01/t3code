import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { DeviceSigningSettings } from "./DeviceSigningSettings";
import "~/index.css";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  settings: { appleTeamId: "", appleRunnerBundleId: "" },
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => mocks.settings,
  useUpdateScopedSettings: () => mocks.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: (props: { title: string; children: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
  SettingsRow: (props: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <h4>{props.title}</h4>
      <p>{props.description}</p>
      <p>{props.status}</p>
      {props.control}
    </div>
  ),
}));

function setup(settings = { appleTeamId: "", appleRunnerBundleId: "" }) {
  mocks.update.mockReset();
  mocks.settings = settings;
}

describe("DeviceSigningSettings", () => {
  it("saves a valid Team ID uppercased on blur", async () => {
    setup();
    await using screen = await render(<DeviceSigningSettings />, { router: false });

    const field = screen.getByLabelText("Apple Team ID");
    await field.fill("abcde12345");
    await field.element().blur();

    expect(mocks.update.mock.calls[0]![0]).toEqual({ appleTeamId: "ABCDE12345" });
  });

  it.each([
    ["Apple Team ID", "TOOSHORT", "A Team ID is 10 uppercase letters and digits."],
    ["Runner bundle id (optional)", "nodots", "A bundle id is reverse-DNS"],
  ])("rejects an invalid %s inline and does not save", async (label, value, message) => {
    setup();
    await using screen = await render(<DeviceSigningSettings />, { router: false });

    const field = screen.getByLabelText(label);
    await field.fill(value);
    await field.element().blur();

    await expect.element(screen.getByText(message, { exact: false })).toBeVisible();
    await expect.element(field).toHaveAttribute("aria-invalid", "true");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("clears a saved value with an empty field and saves a bundle id", async () => {
    setup({ appleTeamId: "ABCDE12345", appleRunnerBundleId: "" });
    await using screen = await render(<DeviceSigningSettings />, { router: false });

    const team = screen.getByLabelText("Apple Team ID");
    await team.fill("");
    await team.element().blur();
    const bundle = screen.getByLabelText("Runner bundle id (optional)");
    await bundle.fill("com.ana.agentdevice.runner");
    await bundle.element().blur();

    expect(mocks.update.mock.calls.map(([patch]) => patch)).toEqual([
      { appleTeamId: "" },
      { appleRunnerBundleId: "com.ana.agentdevice.runner" },
    ]);
    await expect.element(screen.getByText(/VPN & Device Management/)).toBeVisible();
  });
});
