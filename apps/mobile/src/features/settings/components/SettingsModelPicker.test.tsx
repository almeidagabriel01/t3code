import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type PickerProps = {
  selectedModel: unknown;
  optionDescriptors: unknown;
  onSelectModel: (option: { selection: unknown }) => void;
  onUpdateOptionSelections: (options: unknown) => void;
};

const mocks = vi.hoisted(() => ({ picker: null as PickerProps | null }));

vi.mock("../../../state/entities", () => ({ useEnvironmentServerConfig: () => ({}) }));
vi.mock("../../threads/ThreadSettingsSheet", () => ({
  ThreadSettingsPickerScreen: (props: PickerProps) => {
    mocks.picker = props;
    return null;
  },
}));
vi.mock("../../../lib/modelOptions", () => ({
  buildModelOptions: () => [
    { selection: { instanceId: "codex", model: "gpt-5" }, capabilities: "gpt-5-effort" },
  ],
  groupByProvider: (models: unknown) => models,
  withInstanceName: (label: string) => label,
}));
vi.mock("../../../lib/providerOptions", () => ({
  resolveProviderOptionDescriptors: (input: { capabilities: unknown }) => input.capabilities,
}));

import { SettingsModelPicker } from "./SettingsModelPicker";

const gpt = { instanceId: "codex", model: "gpt-5" };
let root: Root;
const onPick = vi.fn();
const render = (selected: unknown) =>
  act(() =>
    root.render(
      <SettingsModelPicker
        title="Default model"
        environmentId={"hub" as never}
        projectId={null}
        selected={selected as never}
        onPick={onPick}
        onClose={() => {}}
      />,
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  onPick.mockReset();
});

afterEach(() => act(() => root.unmount()));

describe("settings model picker", () => {
  it("picks a model and changes the picked model's effort", () => {
    render(gpt);
    expect(mocks.picker?.optionDescriptors).toBe("gpt-5-effort");
    act(() => mocks.picker?.onSelectModel({ selection: gpt }));
    expect(onPick).toHaveBeenLastCalledWith(gpt);
    act(() => mocks.picker?.onUpdateOptionSelections([{ id: "effort", value: "low" }]));
    expect(onPick).toHaveBeenLastCalledWith({ ...gpt, options: [{ id: "effort", value: "low" }] });
  });

  it("offers no effort and changes none before a model is picked", () => {
    render(null);
    expect(mocks.picker?.optionDescriptors).toBeUndefined();
    act(() => mocks.picker?.onUpdateOptionSelections([]));
    expect(onPick).not.toHaveBeenCalled();
  });
});
