import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type PickerProps = {
  title: string;
  selectedModel: unknown;
  optionDescriptors: unknown;
  onSelectModel: (option: { selection: unknown }) => void;
  onUpdateOptionSelections: (options: unknown) => void;
  onClose: () => void;
};

const mocks = vi.hoisted(() => ({
  goBack: vi.fn(),
  draft: vi.fn(),
  editor: null as unknown,
  picker: null as PickerProps | null,
}));

vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: mocks.goBack }) }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <p>{props.children}</p>,
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../threads/ThreadSettingsSheet", () => ({
  ThreadSettingsPickerScreen: (props: PickerProps) => {
    mocks.picker = props;
    return null;
  },
}));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [
    { selection: { instanceId: "codex", model: "gpt-5" }, capabilities: "gpt-5-effort" },
    { selection: { instanceId: "claude", model: "opus" }, capabilities: "opus-effort" },
  ],
  groupByProvider: (models: unknown) => models,
}));
vi.mock("../../lib/providerOptions", () => ({
  resolveProviderOptionDescriptors: (input: { capabilities: unknown }) => input.capabilities,
}));
vi.mock("./assistantDraft", () => ({ updateAssistantDraft: mocks.draft }));
vi.mock("./useAssistantEditor", () => ({ useAssistantEditor: () => mocks.editor }));

import { AssistantModelPickerRouteScreen } from "./AssistantModelPickerRouteScreen";

const opus = { instanceId: "claude", model: "opus" };
const gpt = { instanceId: "codex", model: "gpt-5" };
const editorState = (overrides: object = {}) => ({
  editor: { environmentId: "hub" },
  config: {},
  effectiveProject: { id: "p1" },
  modelSelection: opus,
  defaultModelSelection: null,
  userDefaultModel: gpt,
  ...overrides,
});

let root: Root;
let container: HTMLDivElement;
const render = (params?: { default?: boolean }) =>
  act(() => root.render(<AssistantModelPickerRouteScreen route={{ params } as never} />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.picker = null;
  mocks.draft.mockReset();
  mocks.goBack.mockReset();
  mocks.editor = editorState();
});

afterEach(() => act(() => root.unmount()));

describe("assistant model picker", () => {
  it("picks the conversation's model and keeps its effort for that model", () => {
    render();
    expect(mocks.picker?.title).toBe("Model and effort");
    expect(mocks.picker?.selectedModel).toEqual(opus);
    expect(mocks.picker?.optionDescriptors).toBe("opus-effort");
    act(() => mocks.picker?.onSelectModel({ selection: gpt }));
    expect(mocks.draft).toHaveBeenLastCalledWith({ modelSelection: gpt });
    act(() => mocks.picker?.onUpdateOptionSelections([{ id: "effort", value: "high" }]));
    expect(mocks.draft).toHaveBeenLastCalledWith({
      modelSelection: { ...opus, options: [{ id: "effort", value: "high" }] },
    });
    act(() => mocks.picker?.onClose());
    expect(mocks.goBack).toHaveBeenCalled();
  });

  it("picks the default model, starting from the user's default when none is set", () => {
    render({ default: true });
    expect(mocks.picker?.title).toBe("Default model");
    expect(mocks.picker?.selectedModel).toEqual(gpt);
    act(() => mocks.picker?.onSelectModel({ selection: opus }));
    expect(mocks.draft).toHaveBeenLastCalledWith({ defaultModelSelection: opus });
  });

  it("changes no effort before a model is picked, and asks for a form when none is open", () => {
    mocks.editor = editorState({ modelSelection: null });
    render();
    act(() => mocks.picker?.onUpdateOptionSelections([]));
    expect(mocks.draft).not.toHaveBeenCalled();
    mocks.editor = editorState({ editor: null });
    render();
    expect(container.textContent).toContain("Open an assistant form first.");
  });
});
