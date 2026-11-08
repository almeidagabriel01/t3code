import * as Cause from "effect/Cause";
import type { EnvironmentId, ServerProviderSkill } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    disabled: [] as string[],
    skills: [] as ServerProviderSkill[],
    can: true,
    update: vi.fn(),
    rescan: vi.fn(),
    remove: vi.fn(),
    confirm: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string, select?: (config: unknown) => unknown) =>
    atom === "settings"
      ? { disabledGlobalSkills: mocks.disabled }
      : atom === "config"
        ? select?.({ providers: [{ skills: mocks.skills }] })
        : mocks.can,
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => "settings",
    configValueAtom: () => "config",
    updateSettings: { id: "update", permissionAtom: () => "can" },
  },
}));
vi.mock("../../../state/globalSkills", () => ({
  globalSkillsEnvironment: {
    rescan: { id: "rescan", permissionAtom: () => "can" },
    remove: { id: "remove", permissionAtom: () => "can" },
  },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) =>
    command.id === "update" ? mocks.update : command.id === "rescan" ? mocks.rescan : mocks.remove,
}));
vi.mock("../../../components/ui/Dialog", () => ({ confirm: mocks.confirm }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: (props: { accessibilityRole?: "alert"; children?: ReactNode }) => (
    <p role={props.accessibilityRole}>{props.children}</p>
  ),
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <p>{[props.label, props.description].filter(Boolean).join("|")}</p>
  ),
}));
vi.mock("../../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; footer?: string; children: ReactNode }) => (
    <section aria-label={props.title}>
      {props.children}
      <small>{props.footer}</small>
    </section>
  ),
}));
vi.mock("../../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("../../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    accessibilityLabel: string;
    disabled?: boolean;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      checked={props.value}
      onChange={(event) => props.onValueChange(event.target.checked)}
    />
  ),
}));

import { GlobalSkillsSection } from "./GlobalSkillsSection";

const skill = (name: string, extra: Partial<ServerProviderSkill> = {}): ServerProviderSkill => ({
  name,
  path: `/skills/${name}`,
  scope: "t3",
  enabled: true,
  ...extra,
});

async function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<GlobalSkillsSection environmentId={"env" as EnvironmentId} />);
  });
  const byLabel = <T extends HTMLElement>(label: string) =>
    host.querySelector<T>(`[aria-label="${label}"]`)!;
  return { host, byLabel, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  mocks.disabled = [];
  mocks.skills = [];
  mocks.can = true;
  vi.clearAllMocks();
});

describe("GlobalSkillsSection", () => {
  it("lists T3 skills, turns one off by name and keeps the others' state", async () => {
    mocks.skills = [
      skill("t3:one", { displayName: "One", description: "Does one" }),
      skill("t3:two"),
    ];
    mocks.disabled = ["t3:two"];
    mocks.update.mockResolvedValue({ _tag: "Success" });
    const view = await mount();
    expect(view.host.textContent).toContain("One (t3:one)|Does one");
    expect(view.byLabel<HTMLInputElement>("t3:two enabled").checked).toBe(false);
    await act(async () => view.byLabel<HTMLInputElement>("t3:one enabled").click());
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: { patch: { disabledGlobalSkills: ["t3:two", "t3:one"] } },
    });
    await act(async () => view.byLabel<HTMLInputElement>("t3:two enabled").click());
    expect(mocks.update).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { patch: { disabledGlobalSkills: [] } },
    });
    await view.unmount();
  });

  it("rescans, shows the folder, and removes only after confirming", async () => {
    mocks.skills = [skill("t3:one")];
    mocks.rescan.mockResolvedValue({
      _tag: "Success",
      value: { globalSkillsDir: "/home/me/.t3/skills", skills: [] },
    });
    mocks.remove.mockResolvedValue({
      _tag: "Success",
      value: { globalSkillsDir: "/home/me/.t3/skills", skills: [] },
    });
    const view = await mount();
    await act(async () =>
      [...view.host.querySelectorAll("button")].find((b) => b.textContent === "Rescan")!.click(),
    );
    expect(mocks.rescan).toHaveBeenCalledWith({ environmentId: "env", input: {} });
    expect(view.host.textContent).toContain("/home/me/.t3/skills");
    await act(async () => view.byLabel("Remove t3:one").click());
    expect(mocks.remove).not.toHaveBeenCalled();
    await act(async () => mocks.confirm.mock.calls[0]![0].onConfirm());
    expect(mocks.remove).toHaveBeenCalledWith({ environmentId: "env", input: { name: "t3:one" } });
    await view.unmount();
  });

  it("shows a failed rescan and is inert without permission", async () => {
    mocks.skills = [skill("t3:one")];
    mocks.rescan.mockResolvedValue({ _tag: "Failure", cause: Cause.fail("boom") });
    const view = await mount();
    await act(async () =>
      [...view.host.querySelectorAll("button")].find((b) => b.textContent === "Rescan")!.click(),
    );
    expect(view.host.querySelector("[role=alert]")).not.toBeNull();
    await view.unmount();
    mocks.can = false;
    const locked = await mount();
    expect(locked.byLabel<HTMLInputElement>("t3:one enabled").disabled).toBe(true);
    expect(locked.byLabel<HTMLButtonElement>("Remove t3:one").disabled).toBe(true);
    await locked.unmount();
  });
});
