import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: { start: vi.fn() },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./AssistantFormFields", () => ({
  TextField: (props: { label: string; value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));
vi.mock("./describeAssistant", () => ({ useStartDescribeAssistant: () => mocks.start }));

import { DescribeAssistantRouteScreen } from "./DescribeAssistantRouteScreen";

let root: Root;
let container: HTMLDivElement;
const field = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const start = () =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Start")!;
const type = (value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      field(),
      value,
    );
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.start.mockReset().mockResolvedValue(null);
  await act(async () => root.render(<DescribeAssistantRouteScreen />));
});
afterEach(() => act(() => root.unmount()));

describe("describe screen", () => {
  it("cannot start until something is written", async () => {
    expect(start().disabled).toBe(true);
    await type("   ");
    expect(start().disabled).toBe(true);
    await act(async () => start().click());
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("starts with the description and clears it once the thread opened", async () => {
    await type("A reviewer for my web project");
    expect(start().disabled).toBe(false);
    await act(async () => start().click());
    expect(mocks.start).toHaveBeenCalledWith("A reviewer for my web project");
    expect(field().value).toBe("");
  });

  it("keeps the text and says why it could not start", async () => {
    mocks.start.mockResolvedValue("No Scratch project is available here.");
    await type("A reviewer");
    await act(async () => start().click());
    expect(container.textContent).toContain("No Scratch project is available here.");
    expect(field().value).toBe("A reviewer");
    mocks.start.mockResolvedValue(null);
    await act(async () => start().click());
    expect(container.textContent).not.toContain("No Scratch project");
  });
});
