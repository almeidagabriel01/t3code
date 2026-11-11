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
    configure: vi.fn(),
    githubSignIn: vi.fn(),
    githubSignOut: vi.fn(),
    copied: [] as string[],
    opened: [] as string[],
    alert: vi.fn(),
    confirms: [] as Array<{
      title: string;
      onConfirm: () => void;
      onCancel?: () => void;
    }>,
  },
}));
vi.mock("expo-clipboard", () => ({
  setStringAsync: async (text: string) => void mocks.copied.push(text),
}));
vi.mock("react-native", () => ({
  Linking: { openURL: async (url: string) => void mocks.opened.push(url) },
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
vi.mock("./AssistantFormFields", () => ({
  ChoiceRow: (props: { label: string; selected: boolean; onPress: () => void }) => (
    <button aria-label={props.label} aria-checked={props.selected} onClick={props.onPress} />
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
    configure: mocks.configure,
    githubSignIn: mocks.githubSignIn,
    githubSignOut: mocks.githubSignOut,
  }),
}));

import { AssistantSandboxSection } from "./AssistantSandboxSection";

const signedOut = {
  state: "signed_out",
  login: null,
  userCode: null,
  verificationUri: null,
  error: null,
};
const status = (state: string, extra: object = {}) => ({
  state,
  step: null,
  error: null,
  environmentId: "box",
  url: null,
  linkedEnvironmentsEnabled: true,
  cpus: null,
  whenDone: "discard",
  github: { ...signedOut },
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
  mocks.copied = [];
  mocks.opened = [];
  for (const mock of [
    mocks.start,
    mocks.stop,
    mocks.remove,
    mocks.configure,
    mocks.githubSignIn,
    mocks.githubSignOut,
    mocks.alert,
  ]) {
    mock.mockReset();
  }
  mocks.githubSignIn.mockResolvedValue({ ok: true });
  mocks.githubSignOut.mockResolvedValue({ ok: true });
  mocks.start.mockResolvedValue({ ok: true });
  mocks.stop.mockResolvedValue({ ok: true });
  mocks.remove.mockResolvedValue({ ok: true });
  mocks.configure.mockResolvedValue({ ok: true });
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
    mocks.status = status("not_created", { environmentId: null });
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

  it("lists the CPU limit and the when-done choice, and saves a different one", async () => {
    mocks.status = status("stopped", { cpus: 3 });
    render();
    expect(container.textContent).toContain("CPU limit");
    expect(container.textContent).toContain("The most CPU cores the container may use.");
    // A stored value that is not a preset still shows, selected.
    expect(button("3 cores").getAttribute("aria-checked")).toBe("true");
    expect(button("No limit").getAttribute("aria-checked")).toBe("false");
    await act(async () => button("No limit").click());
    expect(mocks.configure).toHaveBeenLastCalledWith({ cpus: null });
    await act(async () => button("Keep the container").click());
    expect(mocks.configure).toHaveBeenLastCalledWith({ whenDone: "keep" });
    // The current choice, or a read-only environment, saves nothing.
    mocks.configure.mockClear();
    await act(async () => button("3 cores").click());
    await act(async () => button("Discard the container").click());
    mocks.canAct = false;
    render();
    await act(async () => button("No limit").click());
    expect(mocks.configure).not.toHaveBeenCalled();
    mocks.canAct = true;
    mocks.configure.mockResolvedValue({ ok: false, message: "Docker said no" });
    render();
    await act(async () => button("No limit").click());
    expect(mocks.alert).toHaveBeenCalledWith("Could not change the CPU limit", "Docker said no");
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

  it("deletes the files a discarded container left, with one question", async () => {
    mocks.status = status("not_created");
    render();
    act(() => button("Delete files").click());
    expect(mocks.confirms.map((entry) => entry.title)).toEqual(["Delete the sandbox files?"]);
    await act(async () => mocks.confirms[0]!.onConfirm());
    expect(mocks.remove).toHaveBeenLastCalledWith(true);
  });

  it("signs the sandbox in to GitHub with a code to copy and open, cancels, and signs out", async () => {
    mocks.status = status("stopped", { github: { ...signedOut, state: "unavailable" } });
    render();
    expect(container.textContent).toContain("GitHub · Start the sandbox to sign in");
    expect(button("Sign in to GitHub")).toBeNull();

    mocks.status = status("running");
    render();
    expect(container.textContent).toContain("Lets work in the sandbox clone and push");
    mocks.githubSignIn.mockResolvedValue({ ok: false, message: "Not running" });
    await act(async () => button("Sign in to GitHub").click());
    expect(mocks.alert).toHaveBeenCalledWith("Could not sign in to GitHub", "Not running");

    mocks.status = status("running", {
      github: {
        ...signedOut,
        state: "signing_in",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
      },
    });
    render();
    expect(container.textContent).toContain(
      "GitHub · Enter this code on GitHub to finish signing in|ABCD-1234",
    );
    await act(async () => button("Copy code & open GitHub").click());
    expect(mocks.copied).toEqual(["ABCD-1234"]);
    expect(mocks.opened).toEqual(["https://github.com/login/device"]);
    await act(async () => button("Cancel sign-in").click());
    expect(mocks.githubSignOut).toHaveBeenCalledOnce();

    mocks.status = status("running", {
      github: { ...signedOut, state: "signed_in", login: "octo" },
    });
    render();
    expect(container.textContent).toContain("GitHub · Signed in as octo");
    await act(async () => button("Sign out of GitHub").click());
    expect(mocks.githubSignOut).toHaveBeenCalledTimes(2);

    mocks.status = status("running", { github: { ...signedOut, error: "The code expired." } });
    render();
    expect(container.textContent).toContain("GitHub · Not signed in|The code expired.");
  });
});
