import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    drafts: {} as Record<string, { attachments: unknown[] }>,
    capabilities: {} as unknown,
    pickFiles: vi.fn(),
    pickMedia: vi.fn(),
    append: vi.fn(() => 0),
    remove: vi.fn(),
    clearDraft: vi.fn(),
    alert: vi.fn(),
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.drafts }));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: (props: {
    attachments: ReadonlyArray<{ id: string }>;
    onRemove: (id: string) => void;
  }) => (
    <button data-strip onClick={() => props.onRemove(props.attachments[0]!.id)}>
      {props.attachments.length}
    </button>
  ),
}));
vi.mock("../threads/ComposerAttachmentButton", () => ({
  ComposerAttachmentButton: (props: {
    disabled?: boolean;
    onPickMedia: () => Promise<void>;
    onPickFiles: () => Promise<void>;
  }) => (
    <>
      <button data-media disabled={props.disabled} onClick={() => void props.onPickMedia()} />
      <button data-files disabled={props.disabled} onClick={() => void props.onPickFiles()} />
    </>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../lib/composerImages", () => ({
  pickComposerFiles: mocks.pickFiles,
  pickComposerMedia: mocks.pickMedia,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => mocks.drafts },
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () => ({
    get: () =>
      mocks.capabilities === undefined
        ? undefined
        : { environment: { capabilities: mocks.capabilities } },
  }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  composerDraftsAtom: {},
  appendComposerDraftAttachments: mocks.append,
  clearComposerDraft: mocks.clearDraft,
  removeComposerDraftAttachment: mocks.remove,
}));

import {
  DecisionAttachmentControls,
  decisionAttachmentDraftKey,
  useDecisionAttachments,
} from "./DecisionAttachments";

const environmentId = "hub" as never;
const decisionId = "d:1" as never;
const key = decisionAttachmentDraftKey(environmentId, decisionId);

let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useDecisionAttachments>;

function Probe(props: { approval?: boolean; disabled?: boolean }) {
  latest = useDecisionAttachments({ environmentId, decisionId, approval: props.approval ?? false });
  return (
    <DecisionAttachmentControls
      environmentId={environmentId}
      attachments={latest}
      disabled={props.disabled ?? false}
    />
  );
}
const mount = (props: Parameters<typeof Probe>[0] = {}) =>
  act(() => root.render(<Probe {...props} />));
const click = (selector: string) =>
  act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  for (const mock of [
    mocks.pickFiles,
    mocks.pickMedia,
    mocks.append,
    mocks.remove,
    mocks.clearDraft,
    mocks.alert,
  ]) {
    mock.mockReset();
  }
  mocks.append.mockReturnValue(0);
  mocks.drafts = {};
  mocks.capabilities = {};
});
afterEach(() => act(() => root.unmount()));

describe("decision attachments", () => {
  it("keys the draft by environment so uploads find their server", () => {
    expect(key).toBe("hub:decision-d%3A1");
  });

  it("reports only ready uploads for this environment, and is unsettled until all are", () => {
    const ready = {
      id: "a",
      type: "file",
      name: "plan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      uploadedAttachmentId: "pending-a",
      uploadEnvironmentId: "hub",
    };
    mocks.drafts = {
      [key]: { attachments: [ready, { ...ready, id: "b", uploadedAttachmentId: undefined }] },
    };
    mount();
    expect(latest.uploaded).toEqual([
      {
        type: "file",
        id: "pending-a",
        name: "plan.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
      },
    ]);
    expect(latest.settled).toBe(false);
    mocks.drafts = { [key]: { attachments: [ready] } };
    mount();
    expect(latest.settled).toBe(true);
  });

  it("offers attaching only where the server is known and the decision is not an approval", () => {
    mount();
    expect(latest.canAttach).toBe(true);
    mount({ approval: true });
    expect(latest.canAttach).toBe(false);
    mocks.capabilities = undefined;
    mount();
    expect(latest.canAttach).toBe(false);
  });

  it("appends picked files and photos to the decision's draft, and alerts on a pick error", async () => {
    mocks.pickFiles.mockResolvedValue({ files: [{ id: "f" }], error: null });
    mocks.pickMedia.mockResolvedValue({ attachments: [{ id: "m" }], error: "Too big" });
    mount();
    await click("[data-files]");
    expect(mocks.append).toHaveBeenLastCalledWith(key, [{ id: "f" }]);
    expect(mocks.alert).not.toHaveBeenCalled();
    await click("[data-media]");
    expect(mocks.append).toHaveBeenLastCalledWith(key, [{ id: "m" }]);
    expect(mocks.alert).toHaveBeenCalledWith("Could not attach file", "Too big");
    expect(latest.settled).toBe(true);
  });

  it("alerts when too many attachments are rejected or the picker throws", async () => {
    mocks.append.mockReturnValue(2);
    mocks.pickFiles.mockResolvedValueOnce({ files: [{ id: "f" }], error: null });
    mount();
    await click("[data-files]");
    expect(mocks.alert).toHaveBeenLastCalledWith("Could not attach file", "Too many attachments.");
    mocks.pickFiles.mockRejectedValueOnce(new Error("Picker failed"));
    await click("[data-files]");
    expect(mocks.alert).toHaveBeenLastCalledWith("Could not attach file", "Picker failed");
  });

  it("removes a file unless the controls are disabled, and clears the draft", () => {
    mocks.drafts = { [key]: { attachments: [{ id: "a" }] } };
    mount();
    act(() => container.querySelector<HTMLButtonElement>("[data-strip]")!.click());
    expect(mocks.remove).toHaveBeenCalledWith(key, "a");
    mocks.remove.mockClear();
    mount({ disabled: true });
    act(() => container.querySelector<HTMLButtonElement>("[data-strip]")!.click());
    expect(mocks.remove).not.toHaveBeenCalled();
    latest.clear();
    expect(mocks.clearDraft).toHaveBeenCalledWith(key);
  });
});
