import { render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  scopeKind: "all" as string,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: state.scopeKind, environmentIds: [] },
    connectedEnvironments: [{}],
  })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  )) as never,
}));

import { DetectProblemsSettingsRow } from "./DetectProblemsSettings";

it.each([
  {
    scopeKind: "all",
    label: "Detect problems",
    description: "Assistants watch every project for failures and file one card per cause.",
  },
  { scopeKind: "project", label: "Detect problems in this project", description: null },
])(
  "shows the $scopeKind row and turns detection off",
  async ({ scopeKind, label, description }) => {
    state.scopeKind = scopeKind;
    state.updateSettings.mockReset();
    await using _screen = await render(<DetectProblemsSettingsRow />, { router: false }); // no links
    await expect.element(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
    if (description === null) {
      expect(page.getByText(/file one card per cause/).query()).toBeNull();
    } else {
      await expect.element(page.getByText(description)).toBeVisible();
    }
    await userEvent.click(page.getByRole("switch", { name: label, exact: true }));
    expect(state.updateSettings).toHaveBeenCalledWith({ detectProblems: false });
  },
);
