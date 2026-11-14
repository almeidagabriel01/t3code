import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    navigate: vi.fn(),
    write: vi.fn(),
    writable: new Set<string>(),
    active: [] as Array<{ environmentId: string; assistant: { id: string; name: string } }>,
    archived: [] as Array<{ environmentId: string; assistant: { id: string; name: string } }>,
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string; leading?: ReactNode }) => (
    <span>
      {props.leading}
      {props.label}
      {props.description ? ` — ${props.description}` : ""}
    </span>
  ),
}));
vi.mock("../../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress} />
  ),
}));
vi.mock("../../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: Array<{ id: string; title: string; attributes?: { disabled?: boolean } }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`menu:${action.title}`}
          disabled={action.attributes?.disabled}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </>
  ),
}));
vi.mock("../../threads/ThreadSettingsSheet", () => ({ ThreadSettingsPickerScreen: () => null }));
vi.mock("../../../lib/modelOptions", async (importOriginal) => ({
  withInstanceName: (await importOriginal<typeof import("../../../lib/modelOptions")>())
    .withInstanceName,
  // The environment lists gpt-5.5 by its display name; other models are unknown to it.
  buildModelOptions: (_config: unknown, selection: { instanceId: string; model: string } | null) =>
    selection === null
      ? []
      : [
          {
            selection,
            label: selection.model === "gpt-5.5" ? "GPT-5.5" : selection.model,
            // A second Codex instance carries a badge; the default one does not.
            ...(selection.instanceId === "codex_work"
              ? { providerBadge: { displayName: "Work", showBadge: true } }
              : {}),
          },
        ],
}));
vi.mock("../../../state/entities", () => ({ useEnvironmentServerConfig: () => null }));
vi.mock("../../../state/session", () => ({
  useEnvironmentsWithScope: () => mocks.writable,
}));
vi.mock("../../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: mocks.active, archived: mocks.archived }),
}));
vi.mock("../../assistants/assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { name: string } }) => (
    <i>{`av:${props.assistant.name}:`}</i>
  ),
}));
vi.mock("../useSettingsWriter", () => ({ useSettingsWriter: () => mocks.write }));
vi.mock("./SettingsSection", () => ({
  SettingsSection: (props: { title?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));

import { resolveMobileSettingsTargets } from "../settings-scoped-server";
import { ProjectModelSections } from "./ProjectModelSections";

const codex = (model: string) => ({ instanceId: "codex" as never, model });
const environment = (environmentId: string, settings: Partial<ServerSettings>) =>
  ({
    environmentId,
    label: environmentId === "hub" ? "Hub" : "Laptop",
    connection: { phase: "connected" },
    serverConfig: { settings: { ...DEFAULT_SERVER_SETTINGS, ...settings } },
  }) as never;

let root: Root;
let container: HTMLDivElement;
const onReset = vi.fn();
const render = (targets: Parameters<typeof ProjectModelSections>[0]["targets"], disabled = false) =>
  act(() =>
    root.render(
      <ProjectModelSections
        targets={targets}
        disabled={disabled}
        showAssistants
        onReset={onReset}
      />,
    ),
  );
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const section = (title: string) => container.querySelector(`section[aria-label="${title}"]`);

const hubProject = resolveMobileSettingsTargets(
  [
    environment("hub", {
      projectSettingsOverrides: {
        ["p1" as never]: {
          defaultModelSelection: codex("gpt-5.5"),
          assistantModelSelections: {
            ["ada" as never]: codex("gpt-5.5"),
            ["old" as never]: codex("claude-opus-5-5"),
            ["gone" as never]: codex("gpt-5.4-mini"),
          },
        },
      },
    }),
  ],
  [{ environmentId: "hub" as never, id: "p1" as never }],
);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.writable = new Set(["hub", "laptop"]);
  mocks.active = [
    { environmentId: "hub", assistant: { id: "ada", name: "Ada" } },
    { environmentId: "hub", assistant: { id: "beto", name: "Beto" } },
    { environmentId: "laptop", assistant: { id: "lia", name: "Lia" } },
  ];
  mocks.archived = [{ environmentId: "hub", assistant: { id: "old", name: "Olga" } }];
  for (const fn of [mocks.navigate, mocks.write, onReset]) fn.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("ProjectModelSections", () => {
  it("names the project's model, opens its picker and resets a project override", () => {
    render(hubProject);
    expect(section("Model")?.textContent).toContain("GPT-5.5 — Set for this project.");
    act(() => button("Model, GPT-5.5")!.click());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsProjectModel", {
      members: [{ environmentId: "hub", projectId: "p1" }],
    });
    act(() => button("Use the environment's model")!.click());
    expect(onReset).toHaveBeenCalledOnce();

    render(
      resolveMobileSettingsTargets(
        [environment("hub", {})],
        [{ environmentId: "hub" as never, id: "p1" as never }],
      ),
    );
    expect(section("Model")?.textContent).toContain("Automatic — Selected automatically.");
    expect(button("Use the environment's model")).toBeNull();
  });

  it("lists each assistant's model by name, archived and removed ones included", () => {
    render(hubProject);
    const rows = Array.from(
      section("Model by assistant")!.querySelectorAll("button[aria-label^='Model for ']"),
      (row) => row.getAttribute("aria-label"),
    );
    // Sorted by name; a model the environment does not list reads from its slug.
    expect(rows).toEqual([
      "Model for Ada, GPT-5.5",
      "Model for Olga, Claude Opus 5.5",
      "Model for Removed assistant, GPT-5.4-Mini",
    ]);
    act(() => button("Model for Ada, GPT-5.5")!.click());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsProjectModel", {
      members: [{ environmentId: "hub", projectId: "p1" }],
      assistantId: "ada",
    });
  });

  it("removes one assistant's model, writing only its key", () => {
    render(hubProject);
    const remove = section("Model by assistant")!.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="menu:Remove"]',
    );
    act(() => remove[0]!.click());
    expect(mocks.write).toHaveBeenCalledWith(hubProject, [
      {
        environmentId: "hub",
        patch: {
          projectSettingsOverrides: {
            p1: {
              defaultModelSelection: codex("gpt-5.5"),
              assistantModelSelections: { ada: null },
            },
          },
        },
      },
    ]);
  });

  it("adds an assistant of the project's environments that has no model here yet", () => {
    render(hubProject);
    const offered = Array.from(
      section("Model by assistant")!.querySelectorAll("button[aria-label^='menu:']"),
      (item) => item.getAttribute("aria-label"),
    ).filter((label) => label !== "menu:Remove");
    expect(offered).toEqual(["menu:Beto"]);
    act(() => button("menu:Beto")!.click());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsProjectModel", {
      members: [{ environmentId: "hub", projectId: "p1" }],
      assistantId: "beto",
    });
  });

  it("shows one row per assistant across a project's checkouts, Mixed where they differ", () => {
    const high = { ...codex("gpt-5.5"), options: [{ id: "effort", value: "high" }] };
    const twoCheckouts = resolveMobileSettingsTargets(
      [
        environment("hub", {
          projectSettingsOverrides: {
            ["p1" as never]: {
              defaultModelSelection: high as never,
              assistantModelSelections: {
                ["ada" as never]: high as never,
                ["beto" as never]: codex("gpt-5.5"),
              },
            },
            ["p2" as never]: {
              defaultModelSelection: codex("gpt-5.5"),
              assistantModelSelections: {
                ["ada" as never]: high as never,
                ["beto" as never]: codex("gpt-5.4-mini"),
              },
            },
          },
        }),
      ],
      [
        { environmentId: "hub" as never, id: "p1" as never },
        { environmentId: "hub" as never, id: "p2" as never },
      ],
    );
    render(twoCheckouts);
    expect(section("Model")?.textContent).toContain("Mixed");
    const rows = Array.from(
      section("Model by assistant")!.querySelectorAll("button[aria-label^='Model for ']"),
      (row) => row.getAttribute("aria-label"),
    );
    expect(rows).toEqual(["Model for Ada, GPT-5.5", "Model for Beto, Mixed"]);
    act(() =>
      section("Model by assistant")!
        .querySelector<HTMLButtonElement>('button[aria-label="menu:Remove"]')!
        .click(),
    );
    const write = mocks.write.mock.calls[0]?.[1] as Array<{
      patch: { projectSettingsOverrides: Record<string, { assistantModelSelections: unknown }> };
    }>;
    expect(
      Object.entries(write[0]!.patch.projectSettingsOverrides).map(([id, override]) => [
        id,
        override.assistantModelSelections,
      ]),
    ).toEqual([
      ["p1", { ada: null }],
      ["p2", { ada: null }],
    ]);
  });

  it("names the instance beside the model when the driver has several", () => {
    const work = { instanceId: "codex_work" as never, model: "gpt-5.5" };
    render(
      resolveMobileSettingsTargets(
        [
          environment("hub", {
            providerInstances: { ["codex_work" as never]: { driver: "codex" as never } },
            projectSettingsOverrides: {
              ["p1" as never]: {
                defaultModelSelection: work,
                assistantModelSelections: { ["ada" as never]: work },
              },
            },
          }),
        ],
        [{ environmentId: "hub" as never, id: "p1" as never }],
      ),
    );
    expect(button("Model, GPT-5.5 · Work")).not.toBeNull();
    expect(button("Model for Ada, GPT-5.5 · Work")).not.toBeNull();
  });

  it("disables every write without permission to change the environment's settings", () => {
    mocks.writable = new Set();
    render(hubProject);
    expect(button("Model for Ada, GPT-5.5")!.disabled).toBe(true);
    expect(button("Add assistant")!.disabled).toBe(true);
    expect(button("menu:Beto")).toBeNull();
    render(hubProject, true);
    expect(button("Model, GPT-5.5")!.disabled).toBe(true);
    expect(button("Use the environment's model")!.disabled).toBe(true);
  });
});
