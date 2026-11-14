import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  goBack: vi.fn(),
  write: vi.fn(),
  canWrite: true,
  environments: [] as unknown[],
  picker: null as null | {
    title: string;
    selected: unknown;
    onPick: (selection: unknown) => void;
    onClose: () => void;
  },
}));

vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: mocks.goBack }) }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <p>{props.children}</p>,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("./components/SettingsModelPicker", () => ({
  SettingsModelPicker: (props: NonNullable<typeof mocks.picker>) => {
    mocks.picker = props;
    return null;
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => mocks.canWrite }));
vi.mock("./useSettingsWriter", () => ({ useSettingsWriter: () => mocks.write }));
vi.mock("./settings-environment-filter", () => ({
  connectedSettingsTargets: (environments: unknown[]) => environments,
}));

import { ProjectModelPickerRouteScreen } from "./ProjectModelPickerRouteScreen";

const codex = (model: string) => ({ instanceId: "codex", model });
const environment = (environmentId: string, overrides: object) => ({
  environmentId,
  label: environmentId,
  serverConfig: {
    settings: { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: overrides },
  },
});
const members = [
  { environmentId: "hub", projectId: "p1" },
  { environmentId: "laptop", projectId: "p2" },
];

let root: Root;
let container: HTMLDivElement;
const render = (assistantId?: string) =>
  act(() =>
    root.render(
      <ProjectModelPickerRouteScreen
        route={{
          params: {
            members: members as never,
            ...(assistantId === undefined ? {} : { assistantId: assistantId as never }),
          },
        }}
      />,
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.canWrite = true;
  mocks.picker = null;
  mocks.environments = [
    environment("hub", {
      p1: {
        defaultModelSelection: codex("gpt-5.5"),
        assistantModelSelections: { ada: codex("gpt-5.4") },
      },
    }),
    environment("laptop", {}),
  ];
  for (const fn of [mocks.goBack, mocks.write]) fn.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("ProjectModelPickerRouteScreen", () => {
  it("saves the project's model to every checkout", () => {
    render();
    expect(mocks.picker).toMatchObject({ title: "Project model", selected: codex("gpt-5.5") });
    act(() => mocks.picker!.onPick(codex("gpt-5.4")));
    expect(mocks.write.mock.calls[0]![1]).toEqual([
      {
        environmentId: "hub",
        patch: { projectSettingsOverrides: { p1: { defaultModelSelection: codex("gpt-5.4") } } },
      },
      {
        environmentId: "laptop",
        patch: { projectSettingsOverrides: { p2: { defaultModelSelection: codex("gpt-5.4") } } },
      },
    ]);
    act(() => mocks.picker!.onClose());
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });

  it("saves one assistant's model on its own environment, starting from the project's", () => {
    render("ada");
    expect(mocks.picker).toMatchObject({ title: "Assistant model", selected: codex("gpt-5.4") });
    act(() => mocks.picker!.onPick(codex("gpt-5.5")));
    expect(mocks.write.mock.calls[0]![1]).toEqual([
      {
        environmentId: "hub",
        patch: {
          projectSettingsOverrides: {
            p1: {
              defaultModelSelection: codex("gpt-5.5"),
              assistantModelSelections: { ada: codex("gpt-5.5") },
            },
          },
        },
      },
    ]);
    render("beto");
    expect(mocks.picker!.selected).toEqual(codex("gpt-5.5"));
  });

  it("saves nothing without permission, and says so when the project is not connected", () => {
    mocks.canWrite = false;
    render();
    act(() => mocks.picker!.onPick(codex("gpt-5.4")));
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.environments = [];
    render();
    expect(container.textContent).toContain("Connect this project's environment");
  });
});
