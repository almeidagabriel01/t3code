import * as Cause from "effect/Cause";
import type { EnvironmentId, T3McpServer } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    servers: {} as Record<string, unknown>,
    can: true,
    update: vi.fn(),
    confirm: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  TextInput: (props: {
    accessibilityLabel?: string;
    value: string;
    readOnly?: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      readOnly={props.readOnly}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "settings" ? { mcpServers: mocks.servers } : mocks.can),
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => "settings",
    updateSettings: { permissionAtom: () => "can" },
  },
}));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../../components/ui/Dialog", () => ({ confirm: mocks.confirm }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: (props: { accessibilityRole?: "alert"; children?: ReactNode }) => (
    <p role={props.accessibilityRole}>{props.children}</p>
  ),
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <p>{[props.label, props.description].filter(Boolean).join("|")}</p>
  ),
}));
vi.mock("../../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; footer?: string; children: ReactNode }) => (
    <section aria-label={props.title}>
      {props.children}
      <small>{props.footer}</small>
    </section>
  ),
}));
vi.mock("../../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress: () => void;
    children: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    accessibilityLabel: string;
    disabled?: boolean;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      checked={props.value}
      onChange={(event) => props.onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("../../assistants/AssistantFormFields", () => ({
  FieldHeader: (props: { label: string }) => <p>{props.label}</p>,
  ChoiceRow: (props: { label: string; selected: boolean; onPress: () => void }) => (
    <button role="radio" aria-checked={props.selected} onClick={props.onPress}>
      {props.label}
    </button>
  ),
  TextField: (props: {
    label: string;
    value: string;
    disabled?: boolean;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label={props.label}
      value={props.value}
      readOnly={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

import { McpServersSection } from "./McpServersSection";

const MASK = "••••••";
const local: T3McpServer = {
  enabled: true,
  transport: "stdio",
  command: "example",
  args: ["serve"],
  env: { TOKEN: MASK },
};

async function mount(title?: string) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<McpServersSection environmentId={"env" as EnvironmentId} title={title} />);
  });
  const byLabel = <T extends HTMLElement>(label: string) =>
    host.querySelector<T>(`[aria-label="${label}"]`)!;
  const click = (label: string) => act(async () => byLabel(label).click());
  const clickText = (text: string) =>
    act(async () =>
      [...host.querySelectorAll("button")].find((button) => button.textContent === text)!.click(),
    );
  const type = (label: string, value: string) =>
    act(async () => {
      const input = byLabel<HTMLInputElement>(label);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  return { host, byLabel, click, clickText, type, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  mocks.servers = {};
  mocks.can = true;
  mocks.update.mockReset();
  mocks.confirm.mockReset();
});

describe("McpServersSection", () => {
  it("lists servers with their support and switches one off with a per-server patch", async () => {
    mocks.servers = { local };
    mocks.update.mockResolvedValue({ _tag: "Success" });
    const view = await mount("Mac");
    expect(view.host.querySelector("section")?.getAttribute("aria-label")).toBe(
      "MCP servers · Mac",
    );
    expect(view.host.textContent).toContain("local|Command · Codex, Claude, Cursor, ACP agents");
    expect(view.host.textContent).toContain("OpenCode, Pi, and Muse do not support");
    await act(async () => view.byLabel<HTMLInputElement>("local enabled").click());
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: { patch: { mcpServers: { local: { ...local, enabled: false } } } },
    });
    await view.unmount();
  });

  it("adds a server from the form and refuses an invalid one without writing", async () => {
    mocks.update.mockResolvedValue({ _tag: "Success" });
    const view = await mount();
    await view.clickText("Add MCP server");
    await view.type("Server name", "Bad Name");
    await view.type("Command", "node");
    await view.clickText("Add");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(view.host.querySelector("[role=alert]")?.textContent).toContain("Name must start");
    await view.type("Server name", "docs");
    await view.type("Arguments", "server.js");
    await view.clickText("Add variable");
    await view.type("Variable 1", "TOKEN");
    await view.type("Variable 1 value", "secret");
    await view.clickText("Add");
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: {
        patch: {
          mcpServers: {
            docs: {
              enabled: true,
              transport: "stdio",
              command: "node",
              args: ["server.js"],
              env: { TOKEN: "secret" },
            },
          },
        },
      },
    });
    expect(view.byLabel("Server name")).toBeNull();
    await view.unmount();
  });

  it("adds an HTTP server and drops a header row", async () => {
    mocks.update.mockResolvedValue({ _tag: "Success" });
    const view = await mount();
    await view.clickText("Add MCP server");
    await view.clickText("HTTP server (URL)");
    await view.type("Server name", "remote");
    await view.type("URL", "https://mcp.example.test/mcp");
    await view.clickText("Add header");
    await view.click("Remove header 1");
    await view.clickText("Add");
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: {
        patch: {
          mcpServers: {
            remote: {
              enabled: true,
              transport: "http",
              url: "https://mcp.example.test/mcp",
              headers: {},
            },
          },
        },
      },
    });
    await view.unmount();
  });

  it("edits a server keeping its masked secret and its name", async () => {
    mocks.servers = { local };
    mocks.update.mockResolvedValue({ _tag: "Success" });
    const view = await mount();
    await view.click("Edit local");
    expect(view.byLabel<HTMLInputElement>("Server name").readOnly).toBe(true);
    expect(view.byLabel<HTMLInputElement>("Variable 1").readOnly).toBe(true);
    await view.type("Command", "other");
    await view.clickText("Save");
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: { patch: { mcpServers: { local: { ...local, command: "other" } } } },
    });
    await view.unmount();
  });

  it("removes only after confirming, and shows a failed write", async () => {
    mocks.servers = { local };
    mocks.update.mockResolvedValue({ _tag: "Success" });
    const view = await mount();
    await view.click("Remove local");
    expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => mocks.confirm.mock.calls[0]![0].onConfirm());
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: { patch: { mcpServers: { local: null } } },
    });
    await view.unmount();
  });

  it("keeps the form open and shows the reason when the write fails", async () => {
    mocks.update.mockResolvedValue({ _tag: "Failure", cause: Cause.fail("Managed by Acme.") });
    const view = await mount();
    await view.clickText("Add MCP server");
    await view.type("Server name", "docs");
    await view.type("Command", "node");
    await view.clickText("Add");
    expect(view.host.querySelector("[role=alert]")?.textContent).toContain("Managed by Acme.");
    expect(view.byLabel("Server name")).not.toBeNull();
    await view.unmount();
  });

  it("is inert without settings permission", async () => {
    mocks.servers = { local };
    mocks.can = false;
    const view = await mount();
    expect(view.byLabel<HTMLInputElement>("local enabled").disabled).toBe(true);
    expect(view.byLabel<HTMLButtonElement>("Edit local").disabled).toBe(true);
    expect(view.byLabel<HTMLButtonElement>("Remove local").disabled).toBe(true);
    await view.unmount();
  });
});
