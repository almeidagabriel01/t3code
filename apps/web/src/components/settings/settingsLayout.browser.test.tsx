import { HEAVY_QUEUE_DEFAULTS, type HeavyQueueState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";

const QUEUE_OFF: HeavyQueueState = {
  ...HEAVY_QUEUE_DEFAULTS,
  entries: [],
  enabled: false,
  paused: false,
  rules: [],
  maxRunning: 1,
  reasons: {},
  room: true,
  claudeHookInstalled: false,
  deviceIdleMinutes: 20,
  machine: null,
  hold: null,
  linux: null,
  macOnly: [],
  routes: {},
};

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { environmentIds: ["env"] },
    environment: { environmentId: "env" },
  }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("../../state/heavyQueue", () => ({ useHeavyQueue: () => QUEUE_OFF }));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((select: (settings: object) => unknown) =>
    select({ runnerEnabled: false, runnerWhere: "mac", heavySlowAgentJobs: true })) as never,
  useScopedSettingsMixed: (() => false) as never,
  useUpdateScopedSettings: (() => vi.fn()) as never,
}));
vi.mock("../statusBar/useKillTarget", () => ({
  useHeavyQueueActions: () => ({ canChange: true }),
}));
vi.mock("./HeavyNoticesRow", () => ({ HeavyNoticesRow: () => null }));

import { HeavyWorkSettingsSection } from "./HeavyWorkSettings";
import { SettingsPageContainer } from "./settingsLayout";

it("keeps a row a search revealed, with its idle note, after the search target is handled", async () => {
  await using screen = await render(
    <SettingsPageContainer>
      <HeavyWorkSettingsSection />
    </SettingsPageContainer>,
    { router: "/#heavy-work-cpu-ceiling" },
  );
  await vi.waitFor(() => expect(screen.router!.state.location.hash).toBe(""));
  await expect
    .element(
      screen.getByText(
        "Only applies while the heavy work queue is on or jobs run in Hybrid or Mac first.",
      ),
    )
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("Keep memory free");
});
