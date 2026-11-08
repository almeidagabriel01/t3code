import { EnvironmentId } from "@t3tools/contracts";
import type { PreparedVoiceTranscription } from "@t3tools/client-runtime/voice-input";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import { ComposerVoiceButton } from "./ComposerVoiceButton";
import { ComposerVoiceError, ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";
import { useComposerVoice } from "./useComposerVoice";

const mocks = vi.hoisted(() => ({
  transcribe: undefined as undefined | ((uri: string, signal: AbortSignal) => Promise<string>),
  prepareError: undefined as undefined | Error,
  prepared: undefined as undefined | { environmentId: string },
  resolvedContext: undefined as unknown,
}));

vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ label: "Workstation" }),
}));
vi.mock("../../connection/runtime", async () => {
  const [{ Atom }, Layer] = await Promise.all([
    import("effect/reactivity"),
    import("effect/Layer"),
  ]);
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("../../state/session", () => ({ readPreparedConnection: () => mocks.prepared ?? null }));
vi.mock("@t3tools/client-runtime/voice-input/remote", async () => {
  const Effect = await import("effect/Effect");
  return {
    resolveEnvironmentVoiceContext: (prepared: unknown) => Effect.succeed({ prepared }),
    createRemoteVoiceTranscriber: (options: {
      readonly resolveContext: () => Promise<unknown>;
    }) => ({
      prepare: async (): Promise<PreparedVoiceTranscription> => {
        mocks.resolvedContext = await options.resolveContext();
        if (mocks.prepareError) throw mocks.prepareError;
        return {
          locale: "en-US",
          transcribe: (uri, { signal }) => mocks.transcribe!(uri, signal),
        };
      },
    }),
  };
});

function setup(transcribe = async () => "hello there") {
  mocks.transcribe = transcribe;
  mocks.prepareError = undefined;
  mocks.prepared = { environmentId: "environment-1" };
  mocks.resolvedContext = undefined;
}

/** A real microphone-shaped stream: a tone is audible input, a constant zero is a muted device. */
function fakeStream(kind: "tone" | "silence") {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  if (kind === "tone") {
    const oscillator = context.createOscillator();
    oscillator.connect(destination);
    oscillator.start();
  } else {
    const source = context.createConstantSource();
    source.offset.value = 0;
    source.connect(destination);
    source.start();
  }
  return destination.stream;
}

function stubMicrophone(behaviour: "tone" | "silence" | DOMException) {
  return vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(async () => {
    if (behaviour instanceof DOMException) throw behaviour;
    return fakeStream(behaviour);
  });
}

function Harness(props: { onSubmit: (text: string) => void }) {
  const [draft, setDraft] = useState("Hello");
  const [ownerKey, setOwnerKey] = useState("draft-1");
  const draftRef = useRef(draft);
  const listeners = useRef(new Set<() => void>());
  const edit = (text: string) => {
    draftRef.current = text;
    setDraft(text);
    for (const listener of listeners.current) listener();
  };
  const voice = useComposerVoice({
    environmentId: EnvironmentId.make("environment-1"),
    threadId: null,
    providerInstanceId: null,
    ownerKey,
    enabled: true,
    readDraft: () => ({
      text: draftRef.current,
      selection: { start: draftRef.current.length, end: draftRef.current.length },
    }),
    commitDraft: edit,
    subscribeDraft: (listener) => {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  });
  return (
    <>
      <textarea aria-label="Message" value={draft} onChange={(event) => edit(event.target.value)} />
      <button type="button" onClick={() => setOwnerKey("draft-2")}>
        Switch draft
      </button>
      {voice.isActive ? (
        <ComposerVoiceRecorderBar
          voice={voice}
          onSend={() => void voice.send(() => props.onSubmit(draftRef.current))}
        />
      ) : (
        <ComposerVoiceButton {...voice.voiceControl} />
      )}
      <ComposerVoiceError voice={voice} />
    </>
  );
}

const message = () => page.getByRole("textbox", { name: "Message" });
const dictate = () => page.getByRole("button", { name: "Dictate" });
const insert = () => page.getByRole("button", { name: "Insert dictated text" });
const alert = () => page.getByRole("alert");

async function startListening() {
  await userEvent.click(dictate());
  await expect.element(page.getByText(/Recording/)).toBeVisible();
}

it("shows where audio is transcribed, then inserts the text into the draft", async () => {
  setup();
  stubMicrophone("tone");
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  await startListening();
  await expect.element(page.getByText("Transcribes on Workstation")).toBeVisible();
  await userEvent.click(insert());
  await expect.element(message()).toHaveValue("Hello hello there");
  await expect.element(dictate()).toBeVisible();
});

it("sends right after the text lands in the draft", async () => {
  setup();
  stubMicrophone("tone");
  const onSubmit = vi.fn();
  await using _screen = await render(<Harness onSubmit={onSubmit} />);
  await startListening();
  await userEvent.click(page.getByRole("button", { name: "Transcribe and send" }));
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Hello hello there"));
});

it("keeps the draft when cancelled with the button or Escape", async () => {
  setup();
  stubMicrophone("tone");
  const onSubmit = vi.fn();
  await using _screen = await render(<Harness onSubmit={onSubmit} />);
  await startListening();
  await userEvent.click(page.getByRole("button", { name: "Cancel dictation" }));
  await expect.element(dictate()).toBeVisible();
  await startListening();
  await userEvent.keyboard("{Escape}");
  await expect.element(dictate()).toBeVisible();
  await expect.element(message()).toHaveValue("Hello");
  expect(onSubmit).not.toHaveBeenCalled();
});

it("tells the user when nothing was transcribed and leaves the draft alone", async () => {
  setup(async () => "   ");
  stubMicrophone("tone");
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  await startListening();
  await userEvent.click(insert());
  await expect.element(page.getByText(/No speech was detected\./)).toBeVisible();
  await expect.element(message()).toHaveValue("Hello");
});

it("does not insert a transcript into a draft that changed while transcribing", async () => {
  let finish!: (text: string) => void;
  setup(() => new Promise<string>((resolve) => (finish = resolve)));
  stubMicrophone("tone");
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  await startListening();
  await userEvent.click(insert());
  await expect.element(page.getByText(/Transcribing/)).toBeVisible();
  await userEvent.type(message(), "!");
  await act(async () => finish("late words"));
  await expect.element(page.getByText(/The draft changed/)).toBeVisible();
  const value = (message().element() as HTMLTextAreaElement).value;
  expect(value).toContain("Hello");
  expect(value).toContain("!");
  expect(value).not.toContain("late words");
});

it("reports a transcription failure without touching the draft", async () => {
  setup(async () => {
    throw new Error("network down");
  });
  stubMicrophone("tone");
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  await startListening();
  await userEvent.click(insert());
  await expect.element(page.getByText(/Could not transcribe this recording\./)).toBeVisible();
  await expect.element(message()).toHaveValue("Hello");
  await userEvent.click(page.getByRole("button", { name: "Dismiss" }));
  await expect.element(alert()).not.toBeInTheDocument();
});

it("stops with a clear message when the environment cannot transcribe", async () => {
  setup();
  mocks.prepareError = new Error("Codex is signed out");
  const microphone = stubMicrophone("tone");
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  await userEvent.click(dictate());
  await expect.element(page.getByText(/Could not prepare voice transcription\./)).toBeVisible();
  expect(microphone).not.toHaveBeenCalled();
});

it("stops and asks to check the input when no sound arrives", async () => {
  setup();
  stubMicrophone("silence");
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  using _timers = fakeTimers();
  await userEvent.click(dictate());
  await expect.element(page.getByRole("status")).toBeVisible();
  // Preparation finishes in real time, then arms the no-sound deadline on the fake clock.
  await vi.waitFor(
    async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(document.body.textContent).toContain("No sound is reaching T3 Code");
    },
    { timeout: 10_000 },
  );
  await expect.element(message()).toHaveValue("Hello");
});

it.each([
  [new DOMException("blocked", "NotAllowedError"), "The browser blocked the microphone"],
  [new DOMException("none", "NotFoundError"), "No microphone was found"],
  [new DOMException("busy", "NotReadableError"), "Another app may be using it"],
])("explains a microphone failure: %s", async (failure, expected) => {
  setup();
  stubMicrophone(failure);
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  await userEvent.click(dictate());
  await expect.element(page.getByText(new RegExp(expected))).toBeVisible();
});

it("explains that recording needs HTTPS or localhost without a media API", async () => {
  setup();
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  try {
    await using _screen = await render(<Harness onSubmit={vi.fn()} />);
    await userEvent.click(dictate());
    await expect.element(page.getByText(/needs a secure connection/)).toBeVisible();
  } finally {
    // The own property shadows the prototype's; deleting it restores the real API.
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  }
});

it("offers System Settings when macOS denies the desktop app the microphone", async () => {
  setup();
  const microphone = stubMicrophone("tone");
  const openSystemSettings = vi.fn(async () => true);
  vi.stubGlobal("desktopBridge", {
    requestMicrophoneAccess: async () => "denied",
    getClientPlatform: () => "darwin",
    openSystemSettings,
  });
  try {
    await using _screen = await render(<Harness onSubmit={vi.fn()} />);
    await userEvent.click(dictate());
    await expect.element(page.getByText(/Microphone access is required/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Open System Settings" }));
    expect(openSystemSettings).toHaveBeenCalledWith("microphone");
    expect(microphone).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("lets the user retry when the desktop prompt result is unavailable", async () => {
  setup();
  vi.stubGlobal("desktopBridge", { requestMicrophoneAccess: async () => "unavailable" });
  try {
    await using _screen = await render(<Harness onSubmit={vi.fn()} />);
    await userEvent.click(dictate());
    await expect.element(page.getByText(/Microphone access is required/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Open System Settings" }))
      .not.toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("gives the dictation shortcut one visible target in each phase", async () => {
  setup();
  stubMicrophone("tone");
  const target = () =>
    document.querySelector<HTMLButtonElement>('button[data-composer-shortcut="composer.dictate"]');
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  expect(target()?.getAttribute("aria-label")).toBe("Dictate");
  target()!.click();
  await expect.element(page.getByText(/Recording/)).toBeVisible();
  expect(target()?.getAttribute("aria-label")).toBe("Insert dictated text");
  target()!.click();
  await expect.element(message()).toHaveValue("Hello hello there");
});

it("resolves the thread environment's connection when transcription is prepared", async () => {
  setup();
  stubMicrophone("tone");
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  await startListening();
  expect(mocks.resolvedContext).toEqual({ prepared: { environmentId: "environment-1" } });
});

it("has nothing to transcribe with when the environment has no connection", async () => {
  setup();
  mocks.prepared = undefined;
  stubMicrophone("tone");
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  await startListening();
  expect(mocks.resolvedContext).toBeNull();
});

it("cancels a recording when the composer moves to another draft", async () => {
  setup();
  stubMicrophone("tone");
  await using _screen = await render(<Harness onSubmit={vi.fn()} />);
  await startListening();
  await userEvent.click(page.getByRole("button", { name: "Switch draft" }));
  await expect.element(dictate()).toBeVisible();
  await expect.element(message()).toHaveValue("Hello");
});
