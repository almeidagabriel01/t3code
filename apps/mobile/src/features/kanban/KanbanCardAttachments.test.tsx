import type { EnvironmentId, KanbanCard } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  Passthrough: ({ children }: { children?: unknown }) => children,
}));

vi.mock("react-native", () => ({
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => (
    <div role="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </div>
  ),
  View: mocks.Passthrough,
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: mocks.confirm }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: ReadonlyArray<{ id: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <div>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../lib/assetImageSource", () => ({ assetImageSource: () => null }));
vi.mock("../../lib/time", () => ({ relativeTime: () => "1m" }));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => null }));

import { KanbanCardAttachmentList } from "./KanbanCardAttachments";

const attachment = (attachmentId: string, mimeType: string) => ({
  attachmentId,
  name: `${attachmentId}.file`,
  mimeType,
  sizeBytes: 10,
  addedAt: "2026-11-03T00:00:00.000Z",
});
const card = {
  coverAttachmentId: "cover",
  attachments: [
    attachment("cover", "image/png"),
    attachment("photo", "image/jpeg"),
    attachment("doc", "application/pdf"),
  ],
} as unknown as KanbanCard;

function renderList(onPatch?: (patch: unknown) => void) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <KanbanCardAttachmentList
        environmentId={"env" as EnvironmentId}
        card={card}
        onPress={() => {}}
        {...(onPatch ? { onPatch } : {})}
      />,
    ),
  );
  const buttonsOf = (row: string) => [
    ...(container
      .querySelector(`[aria-label="${row}.file actions"]`)
      ?.parentElement?.querySelectorAll("button") ?? []),
  ];
  return {
    container,
    actionsOf: (row: string) => buttonsOf(row).map((button) => button.textContent),
    press: (row: string, id: string) =>
      act(() =>
        buttonsOf(row)
          .find((button) => button.textContent === id)
          ?.click(),
      ),
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("offers cover actions only for images and turns each action into a card patch", () => {
  const onPatch = vi.fn();
  using screen = renderList(onPatch);
  expect(screen.actionsOf("cover")).toEqual(["uncover", "delete"]);
  expect(screen.actionsOf("photo")).toEqual(["cover", "delete"]);
  expect(screen.actionsOf("doc")).toEqual(["delete"]);

  screen.press("cover", "uncover");
  screen.press("photo", "cover");
  expect(onPatch.mock.calls).toEqual([
    [{ coverAttachmentId: null }],
    [{ coverAttachmentId: "photo" }],
  ]);

  screen.press("doc", "delete");
  expect(onPatch).toHaveBeenCalledTimes(2);
  mocks.confirm.mock.calls[0]?.[0].onConfirm();
  expect(onPatch).toHaveBeenLastCalledWith({ removeAttachmentIds: ["doc"] });
});

it("shows no actions on a read-only connection", () => {
  using screen = renderList();
  expect(screen.container.querySelectorAll("button")).toHaveLength(0);
});
