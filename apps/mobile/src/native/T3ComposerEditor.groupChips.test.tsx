import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { ComposerGroupMentions } from "../lib/groupMentionChips";

const native = vi.hoisted(() => ({ documentJson: "" }));

vi.mock("expo", () => ({
  requireNativeView: () => (props: { controlledDocumentJson: string }) => {
    native.documentJson = props.controlledDocumentJson;
    return null;
  },
}));
vi.mock("expo-paste-input", () => ({
  TextInputWrapper: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  StyleSheet: { flatten: (style: unknown) => style },
}));
vi.mock("../lib/useNativePaste", () => ({ useNativePaste: () => () => {} }));
vi.mock("../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => new Proxy({}, { get: () => "#000000" }),
}));
vi.mock("../lib/nativeComposerTheme", () => ({
  createNativeComposerTheme: () => ({ text: "#000000" }),
}));
vi.mock("../lib/contextChipIconSource", () => ({
  contextChipIconUri: (icon: { kind: string; name: string }) => `${icon.kind}:${icon.name}`,
  modelChipIcon: () => ({ accent: undefined, tintsIcon: true }),
  modelChipIconUri: () => "",
}));
vi.mock("../lib/composerChipPresentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/composerChipPresentation")>()),
  contextChipAccent: (accent: string | undefined) => accent,
}));
vi.mock("../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 22 }),
}));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ systemColorsActive: false }),
}));

import { ComposerEditor as IosEditor } from "./T3ComposerEditor.ios";
import { ComposerEditor as AndroidEditor } from "./T3ComposerEditor.native";

const MENTIONS: ComposerGroupMentions = {
  members: [{ handle: "ada", name: "Ada Lovelace", accent: "#336699" }],
  projects: [{ slug: "alpha", name: "Alpha" }],
};

type Chip = { type: string; source: string; label: string; iconUri: string; accent: string };

async function chipsFrom(
  Editor: typeof IosEditor,
  value: string,
  groupMentions?: ComposerGroupMentions,
) {
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <Editor
        value={value}
        onChangeText={() => {}}
        {...(groupMentions ? { groupMentions } : {})}
      />,
    ),
  );
  await act(async () => root.unmount());
  const document_ = JSON.parse(native.documentJson) as { tokensJson: string };
  return (JSON.parse(document_.tokensJson) as Chip[]).map(
    ({ type, source, label, iconUri, accent }) => ({ type, source, label, iconUri, accent }),
  );
}

it.each([
  ["iOS", IosEditor],
  ["Android", AndroidEditor],
])("%s draws a group's @member and #project as their own chips, with names", async (_, Editor) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  expect(await chipsFrom(Editor, "@ada fix #alpha now", MENTIONS)).toEqual([
    {
      type: "member",
      source: "@ada",
      label: "Ada Lovelace",
      iconUri: "chip:bot",
      accent: "#336699",
    },
    {
      type: "project",
      source: "#alpha",
      label: "Alpha",
      iconUri: "chip:folder",
      accent: "#0090cd",
    },
  ]);
  // Outside a group the same text keeps the thread composer's file mention and plain `#`.
  expect(await chipsFrom(Editor, "@ada fix #alpha now")).toEqual([
    expect.objectContaining({ type: "mention", source: "@ada", label: "ada" }),
  ]);
});
