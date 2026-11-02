import type { EnvironmentId, KanbanCardId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  prepare: vi.fn(),
  updateCard: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; loading?: boolean; onPress: () => void }) => (
    <button data-loading={props.loading} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../lib/attachmentUpload", () => ({ prepareTurnAttachments: mocks.prepare }));
vi.mock("../../lib/composerImages", () => ({ pickComposerFiles: mocks.pick }));
vi.mock("./useKanbanActions", () => ({
  useKanbanActions: () => ({ updateCard: mocks.updateCard }),
}));

import { KanbanAddAttachmentButton } from "./KanbanAddAttachmentButton";

const environmentId = "env" as EnvironmentId;
const cardId = "card" as KanbanCardId;
const file = { name: "a.png", type: "image" };
const ready = (id: string) => ({
  status: "ready",
  attachments: [{ id, mimeType: "image/png", sizeBytes: 5 }],
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.pick.mockResolvedValue({ files: [file], error: null });
  mocks.prepare.mockResolvedValue(ready("att1"));
  mocks.updateCard.mockResolvedValue(true);
  host = document.createElement("div");
  root = createRoot(host);
  act(() =>
    root.render(<KanbanAddAttachmentButton environmentId={environmentId} cardId={cardId} />),
  );
});
afterEach(() => act(() => root.unmount()));

const press = () =>
  act(async () => {
    host.querySelector("button")?.click();
  });

describe("KanbanAddAttachmentButton", () => {
  it("uploads the picked file, then adds it to the card in one patch", async () => {
    await press();
    expect(mocks.updateCard).toHaveBeenCalledWith({
      cardId,
      addAttachments: [
        { attachmentId: "att1", name: "a.png", mimeType: "image/png", sizeBytes: 5 },
      ],
    });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(host.textContent).toBe("Add attachment");
  });

  it("shows upload progress while uploading", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.prepare.mockImplementation(
      (input: { onUploadProgress: (id: string, progress: number) => void }) => {
        input.onUploadProgress("x", 0.5);
        return new Promise((resolve) => (finish = resolve));
      },
    );
    await press();
    expect(host.textContent).toBe("Uploading 50%");
    expect(host.querySelector("button")?.dataset.loading).toBe("true");
    await act(async () => finish(ready("att1")));
    expect(host.textContent).toBe("Add attachment");
    expect(mocks.updateCard).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the picker is cancelled", async () => {
    mocks.pick.mockResolvedValue({ files: [], error: null });
    await press();
    expect(mocks.updateCard).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("alerts when picking fails", async () => {
    mocks.pick.mockResolvedValue({ files: [], error: "Too big" });
    await press();
    expect(mocks.alert).toHaveBeenCalledWith("Could not add the attachment", "Too big");
  });

  it("alerts on upload failure but still keeps files that uploaded", async () => {
    mocks.pick.mockResolvedValue({ files: [file, { name: "b.txt", type: "file" }], error: null });
    mocks.prepare.mockResolvedValueOnce(ready("att1")).mockRejectedValueOnce(new Error("Offline"));
    await press();
    expect(mocks.updateCard).toHaveBeenCalledWith({
      cardId,
      addAttachments: [expect.objectContaining({ attachmentId: "att1" })],
    });
    expect(mocks.alert).toHaveBeenCalledWith("Could not add the attachment", "Offline");
  });

  it("treats an abandoned or reference-less upload as a failure", async () => {
    mocks.prepare.mockResolvedValue({ status: "abandoned" });
    await press();
    expect(mocks.updateCard).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not add the attachment",
      "Upload failed for 'a.png'.",
    );
  });

  it("alerts when the card rejects the patch", async () => {
    mocks.updateCard.mockResolvedValue(false);
    await press();
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not add the attachment",
      "The card could not keep the file.",
    );
  });

  it("falls back to a generic message for non-Error failures", async () => {
    mocks.pick.mockRejectedValue("boom");
    await press();
    expect(mocks.alert).toHaveBeenCalledWith("Could not add the attachment", "Upload failed.");
  });
});
