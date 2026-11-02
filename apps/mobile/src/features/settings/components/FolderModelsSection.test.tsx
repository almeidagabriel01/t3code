import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  menus: [] as Array<{ onPressAction: () => void }>,
  rows: [] as Array<{ label: string; disabled?: boolean; onPress?: () => void }>,
  sections: [] as Array<{ footer: string }>,
  listRows: [] as Array<{ label: string; description: string }>,
}));

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../../components/ui/Menu", () => ({
  Menu: (props: { onPressAction: () => void; children: ReactNode }) => {
    mocks.menus.push(props);
    return <div>{props.children}</div>;
  },
}));
vi.mock("../../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description: string }) => {
    mocks.listRows.push(props);
    return null;
  },
}));
vi.mock("../../../components/ui/RowPressable", () => ({
  RowPressable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../lib/modelOptions", () => ({
  buildModelOptions: () => [
    {
      selection: { instanceId: "codex", model: "m1" },
      label: "Model One",
      providerLabel: "Codex",
    },
  ],
}));
vi.mock("../../../state/entities", () => ({ useEnvironmentServerConfig: () => ({}) }));
vi.mock("./SettingsRow", () => ({
  SettingsRow: (props: { label: string; disabled?: boolean; onPress?: () => void }) => {
    mocks.rows.push(props);
    return null;
  },
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: (props: { footer: string; children: ReactNode }) => {
    mocks.sections.push(props);
    return <div>{props.children}</div>;
  },
}));

import { FolderModelsSection } from "./FolderModelsSection";

const environmentId = "env" as never;
const known = { folder: "/work", modelSelection: { instanceId: "codex", model: "m1" } as never };
const unknown = { folder: "/play", modelSelection: { instanceId: "codex", model: "m2" } as never };

let root: Root;
const write = vi.fn();

function render(props: Partial<Parameters<typeof FolderModelsSection>[0]> = {}) {
  mocks.menus.length = mocks.rows.length = mocks.sections.length = mocks.listRows.length = 0;
  act(() =>
    root.render(
      <FolderModelsSection
        environmentId={environmentId}
        rules={[known, unknown]}
        editable
        mixed={false}
        write={write}
        {...props}
      />,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  mocks.navigate.mockClear();
  write.mockClear();
});
afterEach(() => act(() => root.unmount()));

describe("FolderModelsSection", () => {
  it("lists each rule with the model's display name and removes the chosen one", () => {
    render();
    expect(mocks.listRows).toEqual([
      expect.objectContaining({ label: "/work", description: "Model One · Codex" }),
      expect.objectContaining({ label: "/play", description: "m2" }),
    ]);
    act(() => mocks.menus[1]!.onPressAction());
    expect(write).toHaveBeenCalledExactlyOnceWith({ folderModelDefaults: [known] });
  });

  it("opens the add flow on the environment", () => {
    render();
    act(() => mocks.rows[0]!.onPress!());
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsFolderModel", { environmentId });
  });

  it("shows rules read-only, without menus, when more than one environment is selected", () => {
    render({ editable: false });
    expect(mocks.menus).toHaveLength(0);
    expect(mocks.listRows).toHaveLength(2);
    expect(mocks.rows[0]!.disabled).toBe(true);
    expect(mocks.sections[0]!.footer).toMatch(/Select one environment/);
  });

  it("hides rules and the add row when the environments differ", () => {
    render({ mixed: true });
    expect(mocks.listRows).toHaveLength(0);
    expect(mocks.rows).toHaveLength(0);
    expect(mocks.sections[0]!.footer).toMatch(/differ/);
  });
});
