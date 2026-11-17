import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const queue = vi.hoisted(() => ({ retry: vi.fn(), state: undefined as unknown }));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  ScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Image: () => null,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("./ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("./ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./ui/FilePreviewGallery", () => ({
  FilePreviewGallery: (props: { children?: ReactNode }) => props.children,
  useFilePreviewGallery: () => (source: unknown) => source,
}));
vi.mock("./ui/NativePresentation", () => ({
  PresentationSource: (props: { children?: ReactNode }) => props.children,
}));
vi.mock("./PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("./VideoAttachmentTile", () => ({ VideoAttachmentTile: () => null }));
vi.mock("../lib/composerImageGallery", () => ({ composerImageGallery: () => [] }));
vi.mock("../lib/composerImagePreview", () => ({
  MaterializedPreviewKey: vi.fn(),
  materializedPreviewAtom: () => null,
}));
vi.mock("../lib/composerAttachmentFiles", () => ({
  resolveOwnedComposerAttachmentFileUri: () => null,
}));
vi.mock("../lib/composerImages", () => ({
  isFileBackedComposerAttachment: (attachment: { fileUri?: string }) =>
    attachment.fileUri !== undefined,
}));
vi.mock("expo-file-system", () => ({ Paths: { document: { uri: "file:///docs/" } } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("../state/composer-attachment-uploads", () => ({
  useComposerAttachmentUploadState: () => queue.state,
  retryComposerAttachmentUpload: queue.retry,
}));

const { ComposerAttachmentStrip } = await import("./ComposerAttachmentStrip");

const pdf = {
  id: "a1",
  type: "file",
  name: "brief.pdf",
  mimeType: "application/pdf",
  sizeBytes: 10,
  fileUri: "file:///brief.pdf",
} as const;

it("shows and retries an upload its owner runs, not the draft queue's", async () => {
  // The draft queue knows nothing of it; the owner's state is what shows.
  queue.state = { status: "uploading", progress: 0.5 };
  const retry = vi.fn();
  let state: { status: "failed"; reason: string } | { status: "ready" } = {
    status: "failed",
    reason: "Upload rejected (413)",
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(() =>
      root.render(
        <ComposerAttachmentStrip
          environmentId={"hub" as never}
          attachments={[pdf]}
          onRemove={() => {}}
          ownUploads={{ stateOf: () => state, retry }}
        />,
      ),
    );
  render();
  const retryButton = container.querySelector<HTMLButtonElement>(
    '[aria-label="Retry uploading brief.pdf"]',
  )!;
  expect(retryButton.textContent).toContain("Retry");
  await act(async () => retryButton.click());
  expect([retry.mock.calls, queue.retry.mock.calls]).toEqual([[["a1"]], []]);

  state = { status: "ready" };
  render();
  expect(container.querySelector('[aria-label="Retry uploading brief.pdf"]')).toBeNull();

  // Without an owner the draft queue's state shows, and its retry goes to the queue.
  queue.state = { status: "failed", reason: "offline" };
  act(() =>
    root.render(
      <ComposerAttachmentStrip
        environmentId={"hub" as never}
        attachments={[pdf]}
        onRemove={() => {}}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Retry uploading brief.pdf"]')!.click(),
  );
  expect(queue.retry).toHaveBeenCalledWith("hub", "a1");
  act(() => root.unmount());
});
