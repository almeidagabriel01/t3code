import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    status: null as unknown,
    canAct: true,
    start: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    alert: vi.fn(),
    confirms: [] as Array<{
      title: string;
      onConfirm: () => void;
      onCancel?: () => void;
    }>,
  },
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: mocks.alert,
  confirm: (request: { title: string; onConfirm: () => void; onCancel?: () => void }) =>
    mocks.confirms.push(request),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <p>{`${props.label}|${props.description ?? ""}`}</p>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; footer?: string; children?: ReactNode }) => (
    <section>
      <h1>{props.title}</h1>
      {props.children}
      <footer>{props.footer}</footer>
    </section>
  ),
}));
vi.mock("../../state/assistants", () => ({
  useAssistantSandbox: () => mocks.status,
  useAssistantSandboxActions: () => ({
    canAct: mocks.canAct,
    start: mocks.start,
    stop: mocks.stop,
    remove: mocks.remove,
  }),
}));

import { AssistantSandboxSection } from "./AssistantSandboxSection";

const status = (state: string, extra: object = {}) => ({
  state,
  step: null,
  error: null,
  environmentId: "box",
  url: null,
  linkedEnvironmentsEnabled: true,
  ...extra,
});

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(() =>
    root.render(<AssistantSandboxSection environmentId={"hub" as never} suffix=" · Lab" />),
  );
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.status = status("running");
  mocks.canAct = true;
  mocks.confirms = [];
  for (const mock of [mocks.start, mocks.stop, mocks.remove, mocks.alert]) {
    mock.mockReset();
  }
  mocks.start.mockResolvedValue({ ok: true });
  mocks.stop.mockResolvedValue({ ok: true });
  mocks.remove.mockResolvedValue({ ok: true });
});
afterEach(() => act(() => root.unmount()));

describe("AssistantSandboxSection", () => {
  it("shows the state, the step or reason, and the Linked environments requirement", () => {
    mocks.status = status("starting", { step: "Linking this Mac to the sandbox" });
    render();
    expect(container.textContent).toContain("Sandbox · Lab");
    expect(container.textContent).toContain(
      "Sandbox container · Starting|Linking this Mac to the sandbox",
    );
    expect(container.textContent).toContain("Linked environments · On");
    mocks.status = status("failed", { error: "Refused", linkedEnvironmentsEnabled: false });
    render();
    expect(container.textContent).toContain("Sandbox container · Failed|Refused");
    expect(container.textContent).toContain("Linked environments · Off");
    mocks.status = null;
    render();
    expect(container.textContent).toBe("");
  });

  it("enables only the actions the state allows and tells when one fails", async () => {
    mocks.status = status("not_created");
    render();
    expect(button("Start").disabled).toBe(false);
    expect(button("Stop").disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    mocks.start.mockResolvedValue({ ok: false, message: "Docker said no" });
    await act(async () => button("Start").click());
    expect(mocks.alert).toHaveBeenCalledWith("Could not start the sandbox", "Docker said no");

    mocks.status = status("running");
    render();
    await act(async () => button("Stop").click());
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(button("Start").disabled).toBe(true);

    mocks.canAct = false;
    render();
    expect(button("Stop").disabled).toBe(true);
  });

  it("removes the container, then asks whether to keep or delete its files", async () => {
    render();
    act(() => button("Remove").click());
    expect(mocks.confirms.map((entry) => entry.title)).toEqual(["Remove the sandbox container?"]);
    act(() => mocks.confirms[0]!.onConfirm());
    expect(mocks.confirms.map((entry) => entry.title).at(-1)).toBe("Also delete its files?");
    await act(async () => mocks.confirms[1]!.onCancel?.());
    expect(mocks.remove).toHaveBeenLastCalledWith(false);
    await act(async () => mocks.confirms[1]!.onConfirm());
    expect(mocks.remove).toHaveBeenLastCalledWith(true);
    mocks.remove.mockResolvedValue({ ok: false, message: "Busy" });
    await act(async () => mocks.confirms[1]!.onConfirm());
    expect(mocks.alert).toHaveBeenCalledWith("Could not remove the sandbox", "Busy");
  });
});
