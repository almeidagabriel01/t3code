import { RegistryContext } from "@effect/atom-react";
import { EMPTY_WATCH_DRAFT } from "@t3tools/client-runtime/autonomy";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    canAct: true,
    save: vi.fn(),
    remove: vi.fn(),
    goBack: vi.fn(),
    dispatch: vi.fn(),
    alert: vi.fn(),
    confirm: vi.fn(),
    dismissKeyboard: vi.fn(),
    guard: null as null | { prevent: boolean; run: (event: unknown) => void },
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: {
    accessibilityLabel?: string;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  TextInput: (props: {
    accessibilityLabel?: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
  // Babel inlines Platform.OS as ios for these tests, so the Android branches cannot run here.
  Platform: { OS: "ios" },
  Keyboard: { dismiss: mocks.dismissKeyboard },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mocks.goBack, dispatch: mocks.dispatch }),
  usePreventRemove: (prevent: boolean, run: (event: unknown) => void) => {
    mocks.guard = { prevent, run };
  },
}));
vi.mock("@expo/ui/community/datetime-picker", () => ({
  DateTimePicker: (props: {
    mode: string;
    onDismiss: () => void;
    onValueChange: (event: null, date: Date) => void;
  }) => (
    <>
      <button onClick={() => props.onValueChange(null, new Date(2031, 4, 6, 7, 8))}>
        {`pick ${props.mode}`}
      </button>
      <button onClick={props.onDismiss}>dismiss picker</button>
    </>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert, confirm: mocks.confirm }));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; accessory?: ReactNode }) => (
    <>
      {props.label}
      {props.accessory}
    </>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`choose ${action.title}`}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-checked={props.accessibilityState?.selected}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.accessibilityLabel}
      checked={props.value}
      onChange={() => props.onValueChange(!props.value)}
    />
  ),
}));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: (props: { options: { unstable_headerLeftItems: () => unknown[] } }) => (
    <p data-header>{String(props.options.unstable_headerLeftItems().length)}</p>
  ),
}));
vi.mock("../layout/native-glass-header-items", () => ({
  withNativeGlassHeaderItem: (item: { onPress: () => void }) => item,
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: { title: string; children?: ReactNode }) => (
    <>
      <h1>{props.title}</h1>
      {props.children}
    </>
  ),
}));
vi.mock("../../state/autonomy", () => ({
  useAutonomyWatchActions: () => ({
    canAct: mocks.canAct,
    save: mocks.save,
    remove: mocks.remove,
  }),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { assistantWatchEditorAtom, startAssistantWatchEditor } from "./assistantWatchEditor";
import { AssistantWatchRouteScreen } from "./AssistantWatchRouteScreen";

const Screen = () => (
  <RegistryContext.Provider value={appAtomRegistry}>
    <AssistantWatchRouteScreen />
  </RegistryContext.Provider>
);
const projects = [{ id: "p1" as never, label: "Alpha" }];
let root: Root;
let container: HTMLDivElement;
const open = (draft = EMPTY_WATCH_DRAFT) => {
  startAssistantWatchEditor({
    environmentId: "hub" as never,
    assistantId: "a1" as never,
    projects,
    draft,
  });
  act(() => root.render(<Screen />));
};
const press = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  act(() => found.click());
  return found as HTMLButtonElement;
};
const field = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const type = (label: string, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field(label),
      value,
    );
    field(label)!.dispatchEvent(new Event("input", { bubbles: true }));
  });
const saveButton = () =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save watch")!;
const saved = { id: "w1", title: "CI", filter: { event: "run_failed" }, instruction: "" };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.canAct = true;
  mocks.guard = null;
  for (const mock of [
    mocks.goBack,
    mocks.dispatch,
    mocks.alert,
    mocks.confirm,
    mocks.dismissKeyboard,
  ])
    mock.mockReset();
  mocks.save.mockReset().mockResolvedValue({ ok: true });
  mocks.remove.mockReset().mockResolvedValue({ ok: true });
  appAtomRegistry.set(assistantWatchEditorAtom, null);
});
afterEach(() => act(() => root.unmount()));

const toggle = (label: string) => act(() => field(label)!.click());

describe("watch form", () => {
  it("asks to open a watch first when none is open", () => {
    act(() => root.render(<Screen />));
    expect(container.textContent).toContain("Open a watch first.");
  });

  it("creates a watch from what was entered, with human labels for event and project", async () => {
    open();
    expect(container.textContent).toContain("New watch");
    expect(container.textContent).not.toContain("Delete watch");
    expect(field("PR number")).not.toBeNull();
    type("Title", "Ship it");
    press("choose PR checks pass");
    press("choose Alpha");
    type("PR number", "7");
    type("What it should do", "Merge it");
    press("Stop on a date");
    toggle("Only once");
    await act(async () => press("Save watch"));
    const input = mocks.save.mock.calls[0]![0];
    expect(input).toMatchObject({
      assistantId: "a1",
      title: "Ship it",
      filter: { event: "pr_checks_passed", projectId: "p1", prNumber: 7 },
      instruction: "Merge it",
      oneShot: true,
    });
    expect(typeof input.expiresAt).toBe("string");
    expect(mocks.goBack).toHaveBeenCalled();
    expect(appAtomRegistry.get(assistantWatchEditorAtom)).toBeNull();
  });

  it("hides the PR number for other events and goes back to all projects", () => {
    open({ ...EMPTY_WATCH_DRAFT, projectId: "p1" as never });
    press("choose A run fails");
    expect(field("PR number")).toBeNull();
    press("choose All projects");
    expect(appAtomRegistry.get(assistantWatchEditorAtom)?.current).toMatchObject({
      event: "run_failed",
      projectId: null,
    });
  });

  it("shows what is wrong where it happened and keeps the form open", async () => {
    open();
    await act(async () => press("Save watch"));
    expect(container.textContent).toContain("Give the watch a title.");
    expect(mocks.save).not.toHaveBeenCalled();

    type("Title", "CI");
    mocks.save.mockResolvedValue({ ok: false, message: "Too many watches" });
    await act(async () => press("Save watch"));
    expect(container.textContent).toContain("Too many watches");
    expect(mocks.goBack).not.toHaveBeenCalled();
  });

  it("edits one that exists: only a change can be saved, and the expiry can be moved or cleared", async () => {
    open({
      ...EMPTY_WATCH_DRAFT,
      id: "w1" as never,
      title: "CI",
      event: "run_failed",
      expiresAt: "2030-01-02T03:04",
    });
    expect(container.textContent).toContain("Edit watch");
    expect(container.querySelector("[data-header]")?.textContent).toBe("1");
    expect(saveButton().disabled).toBe(true);

    press(
      "Date, " +
        new Date(2030, 0, 2).toLocaleDateString([], {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
    );
    press("pick date");
    expect(container.textContent).toContain("pick date");
    expect(appAtomRegistry.get(assistantWatchEditorAtom)?.current.expiresAt).toBe(
      "2031-05-06T07:08",
    );
    press("dismiss picker");
    expect(container.textContent).not.toContain("pick date");
    expect(saveButton().disabled).toBe(false);
    press(
      "Time, " +
        new Date(2031, 4, 6, 7, 8).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    );
    expect(container.textContent).toContain("pick time");
    press("Keep watching");
    expect(container.textContent).not.toContain("pick time");
    expect(appAtomRegistry.get(assistantWatchEditorAtom)?.current.expiresAt).toBe("");
  });

  it("keeps the chosen date when the date option is chosen again", () => {
    open({ ...EMPTY_WATCH_DRAFT, expiresAt: "2030-01-02T03:04" });
    press("Stop on a date");
    expect(appAtomRegistry.get(assistantWatchEditorAtom)?.current.expiresAt).toBe(
      "2030-01-02T03:04",
    );
  });

  it("deletes after confirming, and reports a refusal", async () => {
    open({ ...EMPTY_WATCH_DRAFT, id: "w1" as never, title: "CI" });
    press("Delete watch");
    const request = mocks.confirm.mock.calls[0]![0];
    expect(request.title).toContain('"CI"');
    await act(async () => request.onConfirm());
    expect(mocks.remove).toHaveBeenCalledWith("w1");
    expect(mocks.goBack).toHaveBeenCalled();

    open({ ...EMPTY_WATCH_DRAFT, id: "w1" as never, title: "CI" });
    mocks.remove.mockResolvedValue({ ok: false, message: "Gone already" });
    press("Delete watch");
    await act(async () => mocks.confirm.mock.calls[1]![0].onConfirm());
    expect(mocks.alert).toHaveBeenCalledWith("Could not delete the watch", "Gone already");
  });

  it("disables saving and deleting for a read-only session", () => {
    mocks.canAct = false;
    open({ ...EMPTY_WATCH_DRAFT, id: "w1" as never, title: "CI" });
    expect(saveButton().disabled).toBe(true);
    expect(press("Delete watch").disabled).toBe(true);
  });

  it("guards leaving with unsaved changes", () => {
    open();
    expect(mocks.guard?.prevent).toBe(false);
    type("Title", "Draft");
    expect(mocks.guard?.prevent).toBe(true);
    const event = { data: { action: "pop" } };
    act(() => mocks.guard!.run(event));
    const [title, , buttons] = mocks.alert.mock.calls.at(-1)!;
    expect(title).toBe("Discard changes?");
    // An open keyboard under the prompt leaves the next screen's composer floating at its height.
    expect(mocks.dismissKeyboard.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.alert.mock.invocationCallOrder.at(-1)!,
    );
    act(() => buttons[1].onPress());
    expect(mocks.dispatch).toHaveBeenCalledWith("pop");
    expect(appAtomRegistry.get(assistantWatchEditorAtom)).toBeNull();
  });
});

describe("watch form while saving", () => {
  it("asks to wait, and lets the close through once it landed", async () => {
    let finish: (value: { ok: true }) => void = () => undefined;
    mocks.save.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    open({ ...EMPTY_WATCH_DRAFT, title: "CI" });
    act(() => void press("Save watch"));
    expect(mocks.guard?.prevent).toBe(true);
    act(() => mocks.guard!.run({ data: { action: "pop" } }));
    expect(mocks.alert).toHaveBeenLastCalledWith(
      "Saving",
      "Wait for the watch to finish saving before leaving.",
    );
    await act(async () => finish({ ok: true }));
    act(() => mocks.guard?.run({ data: { action: "pop" } }));
    expect(mocks.dispatch).toHaveBeenCalledWith("pop");
    expect(saved.id).toBe("w1");
  });
});
