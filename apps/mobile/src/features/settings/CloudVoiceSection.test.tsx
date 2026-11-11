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
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { children: ReactNode; footer?: string }) => (
    <section>
      {props.children}
      <footer>{props.footer}</footer>
    </section>
  ),
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: (props: { children: ReactNode }) => <section>{props.children}</section>,
}));

import { CloudVoiceChoice } from "./CloudVoiceSection";
import { CHATGPT_SPEECH_UNOFFICIAL_NOTE, chatGptSpeechStatusText } from "@t3tools/shared/speech";
import { CloudSpeechError, type CloudSpeechKeys } from "@t3tools/contracts";

const environment = {
  environmentId: EnvironmentId.make("env-a"),
  label: "Laptop",
  serverConfig: { settings: { cloudSpeechCredentials: {} } },
} as unknown as Parameters<typeof CloudVoiceChoice>[0]["environment"];
const activeChatGpt = {
  kind: "cloud",
  environmentId: environment.environmentId,
  provider: "chatgpt",
} as const;

async function mount(
  keys: CloudSpeechKeys,
  active: Parameters<typeof CloudVoiceChoice>[0]["active"] = null,
) {
  mocks.keys = AsyncResult.success(keys);
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(
        <CloudVoiceChoice environment={environment} active={active} open onOpenChange={vi.fn()} />,
      ),
    );
  await render();
  const row = () => host.querySelector<HTMLButtonElement>('[aria-label="ChatGPT subscription"]')!;
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  return {
    host,
    row,
    button,
    rerender: (next: CloudSpeechKeys) => {
      mocks.keys = AsyncResult.success(next);
      return render();
    },
    unmount: () => act(() => root.unmount()),
  };
}

afterEach(() => vi.clearAllMocks());

it("confirms ChatGPT subscription dictation with the disclosure, the risk and no key field", async () => {
  const view = await mount({ openai: false, xai: false, chatgpt: true, chatgptStatus: "ready" });
  expect(view.row().disabled).toBe(false);
  expect(view.row().textContent).toContain("Uses the Codex ChatGPT sign-in · no API key");
  expect(view.row().querySelector("[data-icon=codex]")).not.toBeNull();
  await act(async () => view.row().click());
  expect(view.host.querySelector("input")).toBeNull();
  const request = mocks.confirm.mock.calls[0]![0] as {
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => void;
  };
  expect(request.title).toBe("Use ChatGPT subscription for dictation?");
  expect(request.message).toContain("sends the recording to ChatGPT");
  expect(request.message).toContain(CHATGPT_SPEECH_UNOFFICIAL_NOTE);
  expect(request.confirmText).toBe("Use ChatGPT subscription");
  request.onConfirm();
  expect(mocks.pending).toHaveBeenCalledWith("env-a", "chatgpt");
  expect(mocks.commit).toHaveBeenCalledOnce();
  await view.unmount();
});

it.each(["signed-out", "api-key", "expired", "unreadable", "managed", "codex-off"] as const)(
  "explains how to fix a %s Codex sign-in and offers no way to use it",
  async (status) => {
    const view = await mount({ openai: false, xai: false, chatgpt: false, chatgptStatus: status });
    expect(view.row().disabled).toBe(false);
    expect(view.row().textContent).toContain("Not ready · tap to see how to fix");
    await act(async () => view.row().click());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain(chatGptSpeechStatusText(status, "Laptop"));
    expect(view.host.textContent).toContain(CHATGPT_SPEECH_UNOFFICIAL_NOTE);
    expect(view.button("Use ChatGPT subscription")).toBeUndefined();
    await act(async () => view.button("Back to providers")!.click());
    expect(view.row()).not.toBeNull();
    await view.unmount();
  },
);

it("enables the subscription from its detail once the sign-in becomes ready", async () => {
  const view = await mount({ openai: false, xai: false, chatgpt: false });
  await act(async () => view.row().click());
  expect(view.host.textContent).toContain(chatGptSpeechStatusText("signed-out", "Laptop"));
  await view.rerender({ openai: false, xai: false, chatgpt: true, chatgptStatus: "keychain" });
  expect(view.host.textContent).toContain(chatGptSpeechStatusText("keychain", "Laptop"));
  await act(async () => view.button("Use ChatGPT subscription")!.click());
  expect(mocks.pending).toHaveBeenCalledWith("env-a", "chatgpt");
  expect(mocks.commit).toHaveBeenCalledOnce();
  await view.unmount();
});

it("shows the sign-in status and the last failure for the subscription in use", async () => {
  const view = await mount(
    {
      openai: false,
      xai: false,
      chatgpt: true,
      chatgptStatus: "ready",
      chatgptLastFailure: "network",
    },
    activeChatGpt,
  );
  expect(view.row().textContent).toContain("Tap to see the Codex sign-in status");
  await act(async () => view.row().click());
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(view.host.textContent).toContain(
    new CloudSpeechError({ provider: "chatgpt", reason: "network" }).message,
  );
  expect(view.button("Use ChatGPT subscription")).toBeUndefined();
  expect(view.button("Check again")).toBeDefined();
  await view.unmount();
});

it("keeps ChatGPT subscription unavailable on an older server", async () => {
  const view = await mount({ openai: false, xai: false });
  expect(view.row().disabled).toBe(true);
  expect(view.row().textContent).toContain("Update the environment");
  await view.unmount();
});
