import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    keys: null as unknown,
    confirm: vi.fn(),
    commit: vi.fn(),
    pending: vi.fn(),
    choose: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  ScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  TextInput: () => <input />,
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { name: string }) =>
    atom.name === "keys"
      ? mocks.keys
      : atom.name === "connection"
        ? { prepared: true }
        : AsyncResult.initial(),
  useAtomRefresh: () => vi.fn(),
}));
vi.mock("@t3tools/client-runtime/voice-input", () => ({ setCloudSpeechKey: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../voice-input/voiceDestination", () => ({
  chooseVoiceDestination: mocks.choose,
  pendingCloudVoiceChoice: (...args: unknown[]) => {
    mocks.pending(...args);
    return mocks.commit;
  },
  cloudVoiceConnectionAtom: () => ({ name: "connection" }),
  cloudVoiceKeysAtom: () => ({ name: "keys" }),
  cloudVoiceModelsAtom: () => ({ name: "models" }),
  runSpeech: vi.fn(),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn(), confirm: mocks.confirm }));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: (props: { children: ReactNode }) => <section>{props.children}</section>,
}));
vi.mock("../../components/ProviderIcon", () => ({
  ProviderIcon: (props: { provider: string }) => <i data-icon={props.provider} />,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <p>{props.children}</p>,
}));
vi.mock("../../components/ui/Chip", () => ({ Chip: () => null }));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: {
    label: string;
    description?: string;
    disabled?: boolean;
    leading?: ReactNode;
    onPress: () => void;
  }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.leading}
      {props.description}
    </button>
  ),
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: (props: { children: ReactNode }) => <section>{props.children}</section>,
}));

import { CloudVoiceSection } from "./CloudVoiceSection";

const environment = {
  environmentId: EnvironmentId.make("env-a"),
  label: "Laptop",
  serverConfig: { settings: { cloudSpeechCredentials: {} } },
} as unknown as Parameters<typeof CloudVoiceSection>[0]["environment"];

async function mount(
  keys: { openai: boolean; xai: boolean; chatgpt?: boolean },
  active: Parameters<typeof CloudVoiceSection>[0]["active"] = null,
) {
  mocks.keys = AsyncResult.success(keys);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(<CloudVoiceSection environment={environment} active={active} />),
  );
  await act(async () => host.querySelector("button")!.click());
  const row = host.querySelector<HTMLButtonElement>('[aria-label="ChatGPT account"]')!;
  return { host, row, unmount: () => act(() => root.unmount()) };
}

afterEach(() => vi.clearAllMocks());

it("confirms ChatGPT account dictation with the disclosure and no key field", async () => {
  const view = await mount({ openai: false, xai: false, chatgpt: true });
  expect(view.row.disabled).toBe(false);
  expect(view.row.textContent).toContain("Uses the Codex ChatGPT sign-in on this environment");
  expect(view.row.querySelector("[data-icon=codex]")).not.toBeNull();
  await act(async () => view.row.click());
  expect(view.host.querySelector("input")).toBeNull();
  const request = mocks.confirm.mock.calls[0]![0] as {
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => void;
  };
  expect(request.title).toBe("Use ChatGPT account for dictation?");
  expect(request.message).toContain("sends the recording to ChatGPT");
  expect(request.confirmText).toBe("Use ChatGPT account");
  request.onConfirm();
  expect(mocks.pending).toHaveBeenCalledWith("env-a", "chatgpt");
  expect(mocks.commit).toHaveBeenCalledOnce();
  await view.unmount();
});

it.each([
  {
    name: "not signed in",
    keys: { openai: false, xai: false, chatgpt: false },
    hint: "Sign in to Codex with ChatGPT",
  },
  { name: "an older server", keys: { openai: false, xai: false }, hint: "Update the environment" },
])("shows ChatGPT account as a non-interactive row when $name", async ({ keys, hint }) => {
  const view = await mount(keys);
  expect(view.row.disabled).toBe(true);
  expect(view.row.textContent).toContain(hint);
  await view.unmount();
});

it("does not prompt again for the ChatGPT account already in use", async () => {
  const view = await mount(
    { openai: false, xai: false, chatgpt: true },
    { kind: "cloud", environmentId: environment.environmentId, provider: "chatgpt" },
  );
  await act(async () => view.row.click());
  expect(mocks.confirm).not.toHaveBeenCalled();
  await view.unmount();
});
