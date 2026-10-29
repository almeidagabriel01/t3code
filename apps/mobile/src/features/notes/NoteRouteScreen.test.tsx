import type { NoteOutboxRow } from "@t3tools/client-runtime/notes/outbox";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps, ReactNode } from "react";
import { act, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { document as noteDocument, row } from "./test-fixtures";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    revision: 0,
    listeners: new Set<() => void>(),
    rows: [] as ReadonlyArray<NoteOutboxRow>,
    connected: false,
    taskIndex: 0,
    taskText: "task",
    read: vi.fn(),
    enqueue: vi.fn(),
    restore: vi.fn(),
    flush: vi.fn(),
    claim: (body: string) => body,
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Linking: { openURL: vi.fn() },
  TextInput: (props: {
    value: string;
    onChangeText: (value: string) => void;
    editable: boolean;
  }) => (
    <textarea
      value={props.value}
      disabled={!props.editable}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => (
    <section data-testid="note-scroll-content">{children}</section>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: vi.fn(), dispatch: vi.fn(), navigate: vi.fn() }),
  usePreventRemove: () => undefined,
}));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn(), confirm: vi.fn() }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: {
    label: string;
    disabled?: boolean;
    loading?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={props.disabled || props.loading} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../lib/attachmentUpload", () => ({ prepareTurnAttachments: vi.fn() }));
vi.mock("../../lib/composerImages", () => ({ pickComposerImages: vi.fn() }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: ({
    markdown,
    onTaskListItemPress,
  }: {
    markdown: string;
    onTaskListItemPress?: (event: { index: number; checked: boolean; text: string }) => void;
  }) => {
    const [checked, setChecked] = useState(false);
    return (
      <>
        <p>{markdown}</p>
        <button
          disabled={!onTaskListItemPress}
          onClick={() => {
            setChecked(!checked);
            onTaskListItemPress?.({
              index: mocks.taskIndex,
              checked: !checked,
              text: mocks.taskText,
            });
          }}
        >
          Native checkbox {checked ? "checked" : "unchecked"}
        </button>
      </>
    );
  },
}));
vi.mock("../../state/notes", () => ({
  notesEnvironment: { read: {}, update: {} },
  useNotesFeed: () => AsyncResult.initial(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.read }));
vi.mock("../files/FileMarkdownPreview", () => ({ useMarkdownPreviewStyles: () => ({}) }));
vi.mock("../threads/ThreadMarkdownImage", () => ({ ThreadMarkdownImage: () => null }));
vi.mock("./NoteCard", () => ({ NoteCardSection: () => null }));
vi.mock("./NoteProjectPicker", () => ({ NoteProjectPicker: () => null }));
vi.mock("./notes-state", () => ({
  notesCommandOptions: {},
  useNotesOutbox: () => {
    useSyncExternalStore(
      (listener) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
      },
      () => mocks.revision,
    );
    return mocks.rows;
  },
  useNoteDraftAccess: () => ({
    canEdit: true,
    canAct: mocks.connected,
    connected: mocks.connected,
  }),
  flushNotes: mocks.flush,
  notesOutbox: {
    restore: mocks.restore,
    getSnapshot: () => mocks.rows,
    enqueue: mocks.enqueue,
    error: () => undefined,
    claimImages: (_environmentId: string, _path: string, body: string) => mocks.claim(body),
  },
}));

import { NoteRouteScreen } from "./NoteRouteScreen";

let root: Root;
let container: HTMLDivElement;
const props = {
  route: { params: { environmentId: "hub", path: "note.md" } },
} satisfies ComponentProps<typeof NoteRouteScreen>;
const render = () => {
  mocks.revision++;
  for (const listener of mocks.listeners) listener();
  root.render(<NoteRouteScreen {...props} />);
};
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function type(body: string) {
  const input = container.querySelector("textarea");
  if (!input) throw new Error("Missing note editor");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, body);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.rows = [row()];
  mocks.connected = false;
  mocks.taskIndex = 0;
  mocks.taskText = "task";
  mocks.claim = (body) => body;
  mocks.read.mockReset().mockResolvedValue(AsyncResult.success(noteDocument()));
  mocks.enqueue.mockReset().mockImplementation(async (edit: { body: string }) => edit.body);
  mocks.restore.mockReset().mockResolvedValue(undefined);
  mocks.flush.mockReset().mockResolvedValue(undefined);
});
afterEach(() => act(() => root.unmount()));

describe("note editor snapshot", () => {
  it("keeps unsaved text and releases saving after storage fails so the edit can be retried", async () => {
    const save = Promise.withResolvers<string>();
    mocks.enqueue.mockReturnValueOnce(save.promise);
    await act(async () => render());
    act(() => button("Edit").click());
    act(() => type("keep this edit"));
    act(() => button("Save").click());
    expect(button("Save").disabled).toBe(true);
    expect(container.querySelector("textarea")?.disabled).toBe(true);

    await act(async () => save.reject(new Error("Device storage unavailable")));
    expect(container.textContent).toContain("Device storage unavailable");
    expect(container.textContent).toContain("Unsaved edits");
    expect(container.querySelector("textarea")?.value).toBe("keep this edit");
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(button("Save").disabled).toBe(false);
    expect(mocks.flush).not.toHaveBeenCalled();

    await act(async () => button("Save").click());
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue.mock.calls[1]?.[0]).toMatchObject({ body: "keep this edit" });
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Device storage unavailable");
  });

  it("updates the saved-on-device status through send, conflict and acknowledgement", async () => {
    await act(async () => render());
    const scrollContent = container.querySelector('[data-testid="note-scroll-content"]');
    expect(scrollContent?.textContent).toContain("Saved on this device · syncs when connected");
    await act(async () => {
      mocks.rows = [{ ...row(), inFlight: row() }];
      render();
    });
    expect(scrollContent?.textContent).toContain("Syncing…");
    expect(container.textContent).not.toContain("Saved on this device · syncs when connected");
    await act(async () => {
      mocks.rows = [{ ...row(), state: "conflict", current: noteDocument("theirs") }];
      render();
    });
    expect(scrollContent?.textContent).toContain("Needs your choice");
    expect(button("Compare versions").disabled).toBe(false);
    expect(button("Edit").disabled).toBe(true);
    await act(async () => {
      mocks.rows = [];
      mocks.connected = true;
      render();
    });
    expect(container.textContent).not.toContain("Needs your choice");
    expect(container.textContent).toContain("hub");
  });

  it("keeps newer unsaved text visible and saveable after the pending version is acknowledged", async () => {
    await act(async () => render());
    act(() => button("Edit").click());
    act(() => type("unsaved B"));
    expect(container.textContent).toContain("Unsaved edits");
    await act(async () => {
      mocks.connected = true;
      mocks.rows = [];
      render();
    });
    expect(container.querySelector("textarea")?.value).toBe("unsaved B");
    await act(async () => button("Save").click());
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: "unsaved B" }));
  });

  it("keeps a clean pending snapshot available offline after acknowledgement", async () => {
    await act(async () => render());
    await act(async () => {
      mocks.rows = [];
      render();
    });
    expect(container.textContent).toContain("mine");
    act(() => button("Edit").click());
    expect(container.querySelector("textarea")?.value).toBe("mine");
  });

  it("retains a draft restored after mount when acknowledgement is followed by a failed read", async () => {
    const restored = Promise.withResolvers<void>();
    mocks.rows = [];
    mocks.restore.mockReturnValue(restored.promise);
    await act(async () => render());
    await act(async () => {
      mocks.rows = [row()];
      restored.resolve();
      render();
    });
    mocks.read.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("connection lost"))));
    await act(async () => {
      mocks.rows = [];
      mocks.connected = true;
      render();
    });
    expect(mocks.read).toHaveBeenCalled();
    act(() => button("Edit").click());
    expect(container.querySelector("textarea")?.value).toBe("mine");
  });

  it("adopts Use theirs when the editor has no active edits", async () => {
    mocks.rows = [{ ...row(), state: "conflict", current: noteDocument("theirs") }];
    await act(async () => render());
    await act(async () => {
      mocks.rows = [];
      render();
    });
    act(() => button("Edit").click());
    expect(container.querySelector("textarea")?.value).toBe("theirs");
  });

  it("preserves dirty text when a conflict row is removed by Use theirs", async () => {
    await act(async () => render());
    act(() => button("Edit").click());
    act(() => type("unsaved B"));
    await act(async () => {
      mocks.rows = [{ ...row(), state: "conflict", current: noteDocument("theirs") }];
      render();
    });
    await act(async () => {
      mocks.rows = [];
      render();
    });
    expect(container.querySelector("textarea")?.value).toBe("unsaved B");
    await act(async () => button("Save").click());
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: "unsaved B" }));
  });
});

describe("uploaded images", () => {
  const pending = "![shot.png](t3-attachment:pending-11111111-1111-4111-8111-111111111111)";
  const stored = "![shot.png](t3-attachment:note-abc-22222222-2222-4222-8222-222222222222)";

  it("edits and saves the stored image ids once the server has claimed the upload", async () => {
    mocks.rows = [{ ...row(), body: `A\n${pending}` }];
    mocks.claim = (body) => body.replace(pending, stored);
    mocks.enqueue.mockImplementation(async (edit: { body: string }) => mocks.claim(edit.body));
    await act(async () => render());
    act(() => button("Edit").click());
    expect(container.querySelector("textarea")?.value).toBe(`A\n${stored}`);
    // A ref typed back in by hand still saves under the stored id.
    act(() => type(`A\n${pending}\nB`));
    await act(async () => button("Save").click());
    expect(container.textContent).toContain(`A\n${stored}\nB`);
    expect(container.textContent).not.toContain("pending-");
  });
});

it.each([
  ["footnote suppression", "- a\n[^a]:\n    - [ ] foot\n\n- [ ] last", 0, "foot"],
  ["tabbed blockquote", ">\t- [ ] a\n>\t\n>\t    - [ ] b\n\n- [ ] c", 1, "c"],
  ["ordered task after code", "    a\n  2. [ ] b\n\n- [ ] c", 0, "b"],
] as const)(
  "keeps %s taps out of the outbox, resets native state and offers markdown editing",
  async (_name, body, index, text) => {
    mocks.rows = [{ ...row(), body }];
    mocks.taskIndex = index;
    mocks.taskText = text;
    await act(async () => render());
    await act(async () => button("Native checkbox unchecked").click());
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Edit the markdown to change this checkbox.");
    expect(button("Native checkbox unchecked")).toBeDefined();
    act(() => button("Edit").click());
    expect(container.querySelector("textarea")?.value).toBe(body);
  },
);

it("enqueues a checkbox only when its native text and source slot agree", async () => {
  mocks.rows = [{ ...row(), body: "- [ ] **task**\n- [ ] other" }];
  await act(async () => render());
  await act(async () => button("Native checkbox unchecked").click());
  expect(mocks.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ body: "- [x] **task**\n- [ ] other" }),
  );
});
