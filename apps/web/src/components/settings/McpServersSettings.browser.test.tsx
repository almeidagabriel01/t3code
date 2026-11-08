import type { EnvironmentId, T3McpServer } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { McpServersSettings } from "./McpServersSettings";

const mocks = vi.hoisted(() => ({
  servers: {} as Record<string, unknown>,
  phase: "connected" as string,
  scopeKind: "environment" as string,
  can: true,
  update: vi.fn(),
}));

vi.mock("./SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    environment: {
      environmentId: "env",
      connection: { phase: mocks.phase },
      serverConfig: {},
    },
    scope: { kind: mocks.scopeKind },
  }),
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: (_id: string, select: (settings: { mcpServers: unknown }) => unknown) =>
    select({ mcpServers: mocks.servers }),
}));
vi.mock("../../state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../../state/server")>()),
    serverEnvironment: {
      updateSettings: { permissionAtom: () => Atom.make(mocks.can) },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));

const MASK = "••••••";
const local: T3McpServer = {
  enabled: true,
  transport: "stdio",
  command: "example",
  args: ["serve"],
  env: { TOKEN: MASK },
};

function setup(servers: Record<string, unknown> = {}) {
  mocks.servers = servers;
  mocks.phase = "connected";
  mocks.scopeKind = "environment";
  mocks.can = true;
  mocks.update.mockReset();
  mocks.update.mockResolvedValue({ _tag: "Success" });
}

const mount = () => render(<McpServersSettings />, { router: false }); // scope and settings are mocked

it("lists a server with where it runs and turns it off with a per-server patch", async () => {
  setup({ local });
  await using _screen = await mount();
  await expect.element(page.getByText("local", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/Agents see it as local_t3/)).toBeVisible();
  await userEvent.click(page.getByRole("switch", { name: "Enable local" }));
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId: "env" as EnvironmentId,
    input: { patch: { mcpServers: { local: { ...local, enabled: false } } } },
  });
});

it("adds a stdio server, refusing an invalid name before writing", async () => {
  setup();
  await using _screen = await mount();
  await userEvent.click(page.getByRole("button", { name: "Add server" }));
  await userEvent.fill(page.getByLabelText("Name"), "Bad Name");
  await userEvent.fill(page.getByLabelText("Command"), "node");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await expect.element(page.getByText(/Name must start/)).toBeVisible();
  expect(mocks.update).not.toHaveBeenCalled();
  await userEvent.fill(page.getByLabelText("Name"), "docs");
  await userEvent.fill(page.getByLabelText("Arguments, one per line"), "server.js");
  await userEvent.click(page.getByRole("button", { name: "Add key" }));
  await userEvent.fill(page.getByLabelText("Key 1"), "TOKEN");
  await userEvent.fill(page.getByLabelText("Value 1"), "secret");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await vi.waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env" as EnvironmentId,
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
    }),
  );
});

it("adds an HTTP server with a header row it can drop", async () => {
  setup();
  await using _screen = await mount();
  await userEvent.click(page.getByRole("button", { name: "Add server" }));
  await userEvent.click(page.getByRole("radio", { name: "HTTP" }));
  await userEvent.fill(page.getByLabelText("Name"), "remote");
  await userEvent.fill(page.getByLabelText("URL"), "https://mcp.example.test/mcp");
  await userEvent.click(page.getByRole("button", { name: "Add key" }));
  await userEvent.click(page.getByRole("button", { name: "Remove", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await vi.waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env" as EnvironmentId,
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
    }),
  );
});

it("edits a saved server without touching its masked secret or name", async () => {
  setup({ local });
  await using _screen = await mount();
  await userEvent.click(page.getByRole("button", { name: "Edit" }));
  await expect.element(page.getByLabelText("Name")).toBeDisabled();
  await expect.element(page.getByLabelText("Key 1")).toBeDisabled();
  await userEvent.fill(page.getByLabelText("Command"), "other");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await vi.waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env" as EnvironmentId,
      input: { patch: { mcpServers: { local: { ...local, command: "other" } } } },
    }),
  );
});

it("removes a server only after confirming", async () => {
  setup({ local });
  await using _screen = await mount();
  await userEvent.click(page.getByRole("button", { name: "Remove", exact: true }));
  expect(mocks.update).not.toHaveBeenCalled();
  await userEvent.click(
    page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }),
  );
  await vi.waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env" as EnvironmentId,
      input: { patch: { mcpServers: { local: null } } },
    }),
  );
});

it("shows why a write failed and keeps the form open", async () => {
  setup();
  mocks.update.mockResolvedValue({ _tag: "Failure", cause: Cause.fail("Managed by Acme.") });
  await using _screen = await mount();
  await userEvent.click(page.getByRole("button", { name: "Add server" }));
  await userEvent.fill(page.getByLabelText("Name"), "docs");
  await userEvent.fill(page.getByLabelText("Command"), "node");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await expect.element(page.getByText(/Managed by Acme/).first()).toBeVisible();
  await expect.element(page.getByLabelText("Name")).toBeVisible();
});

it("is read-only for a project scope and says so while disconnected", async () => {
  setup({ local });
  mocks.scopeKind = "project";
  await using _screen = await mount();
  await expect.element(page.getByText(/Environment-wide setting/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add server" })).toBeDisabled();
  await expect.element(page.getByRole("switch", { name: "Enable local" })).toBeDisabled();
});

it("asks to connect an environment first", async () => {
  setup();
  mocks.phase = "connecting";
  await using _screen = await mount();
  await expect.element(page.getByText(/Connect an environment/)).toBeVisible();
});
