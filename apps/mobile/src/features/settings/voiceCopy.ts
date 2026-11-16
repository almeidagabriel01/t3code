import { CLOUD_SPEECH_LABELS } from "@t3tools/contracts";
import { CHATGPT_SPEECH_UNOFFICIAL_NOTE } from "@t3tools/shared/speech";

export const MICROPHONE_COPY = {
  wired: {
    label: "Wired",
    row: "Other wired",
    description: "Headsets and USB microphones not listed here",
  },
  bluetooth: {
    label: "Bluetooth",
    row: "Other Bluetooth",
    description: "AirPods, headsets, and cars not listed here",
    androidDescription: "Earbuds, headsets, and cars, including Android Auto, not listed here",
  },
  builtIn: {
    label: "Built-in",
    row: "Built-in microphone",
    description: "The microphone on this device",
  },
  carPlay: { label: "CarPlay", row: "CarPlay", description: "The car’s microphone" },
} as const;

/** The Voice page's fixed text; Settings search reads these same strings. */
export const VOICE_COPY = {
  transcribeOn: {
    title: "Transcribe on",
    thisDevice: "This device",
    thisDeviceDescription: "Audio stays on this device and is transcribed here.",
    notConnected: "Not connected",
    unavailable: "Transcription unavailable",
    sendRecordings: "Send finished recordings to this environment.",
    previousEnvironment: "Previously selected environment",
    noLongerPaired: "No longer paired",
  },
  unavailableExplanation: {
    android:
      "Dictation on this device needs Android 12 or later and Google speech services that support your language. Your keyboard’s voice typing is separate.",
    ios: "Dictation on this device needs iOS 26 or later, a supported device, and a supported language. Your keyboard’s dictation is separate.",
  },
  microphoneAccess: {
    title: "Microphone access",
    askFooter: "Allow microphone access to record and to see your microphones.",
    deniedFooter: "Turn on microphone access for T3 Code in Settings to use voice input.",
  },
  preferredOrder: {
    title: "Preferred order",
    footer:
      "Voice input uses the first connected microphone in this list. A wired or Bluetooth microphone is added by name the first time you dictate with it connected; until then it falls under Other. Swipe left on a named microphone to forget it.",
    androidNote:
      " Android may still use a different microphone if the preferred one can’t be routed.",
  },
  localModel: {
    title: "Local model",
    notAvailable: "Not available on this environment",
    checking: "Checking…",
    noModelInstalled: "No model installed · Choose one to download",
  },
  cloudProvider: {
    title: "Cloud provider",
    keyOrSubscription: "Your API key or ChatGPT subscription",
    notConnected: "Not connected",
    sheetTitle: "Cloud providers",
    codexSignIn: "Codex sign-in",
    model: "Model",
    apiKey: "API key",
    updateEnvironment: "Update the environment to use this provider",
    seeSignInStatus: "Tap to see the Codex sign-in status",
    usesCodexSignIn: "Uses the Codex ChatGPT sign-in · no API key",
    notReady: "Not ready · tap to see how to fix",
    manageKey: "Tap to manage key",
    keySavedChooseModel: "API key saved · choose a model to use it",
    keySaved: "API key saved",
    addKey: "Add an API key to use this provider",
    askAdministrator: "Ask an environment administrator to add an API key",
    savedKeyFooter:
      "Uses the API key saved on this environment. The model choice applies only to this device.",
  },
  modelsPage: { title: "Transcription models" },
} as const;

const { androidNote, ...preferredOrder } = VOICE_COPY.preferredOrder;

export const VOICE_PAGE_LABELS: readonly string[] = [
  ...Object.values(VOICE_COPY.transcribeOn),
  ...Object.values(VOICE_COPY.unavailableExplanation),
  ...Object.values(VOICE_COPY.microphoneAccess),
  ...Object.values(preferredOrder),
  androidNote.trim(),
  ...Object.values(VOICE_COPY.localModel),
  ...Object.values(VOICE_COPY.cloudProvider),
  ...Object.values(CLOUD_SPEECH_LABELS),
  CHATGPT_SPEECH_UNOFFICIAL_NOTE,
  VOICE_COPY.modelsPage.title,
  ...Object.values(MICROPHONE_COPY).flatMap((copy) => Object.values(copy)),
  // The common name for dictation on this device.
  "on-device",
];
