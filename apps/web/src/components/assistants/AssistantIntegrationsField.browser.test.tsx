import type {
  AssistantIntegrations,
  DetectedServer,
  EnvironmentId,
  IntegrationCatalogEntry,
  IntegrationsState,
  IntegrationView,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import {
  AssistantIntegrationChips,
  AssistantIntegrationsField,
  sameIntegrations,
} from "./AssistantIntegrationsField";

const mocks = vi.hoisted(() => ({ state: null as IntegrationsState | null }));
vi.mock("../../state/integrations", () => ({ useIntegrationsState: () => mocks.state }));

const entry = (id: string, name: string): IntegrationCatalogEntry =>
  ({
    id,
    name,
    category: "dev",
    description: "",
    docsUrl: "https://example.com",
    server: { transport: "http", url: `https://${id}.example.com/mcp` },
    auth: { kind: "oauth", registration: "dynamic" },
    match: { urls: [], packages: [], names: [] },
  }) as IntegrationCatalogEntry;

const view = (name: string, status: IntegrationView["status"]): IntegrationView =>
  ({ name, catalogId: name, auth: "oauth", status, availability: "assistants" }) as IntegrationView;

const STATE: IntegrationsState = {
  catalog: [entry("linear", "Linear"), entry("notion", "Notion"), entry("github", "GitHub")],
  integrations: [view("linear", "connected"), view("notion", "needs-sign-in")],
  ownApps: [],
  loopbackRedirectUri: "http://127.0.0.1:43110/integrations/callback",
  detected: [
    {
      id: "gh",
      name: "github",
      origin: "claude-code",
      instanceId: "claude" as ProviderInstanceId,
      scope: "user",
      catalogId: "github",
      transport: "http",
      loaded: "connected",
      enabled: true,
      copyable: false,
      secretKeys: [],
      needsValue: [],
    } as DetectedServer,
  ],
  detectionSources: [],
};

function Harness(props: {
  readonly initial: AssistantIntegrations;
  readonly onChange: (next: AssistantIntegrations) => void;
  readonly driverKind: string;
  readonly workspace?: "host" | "sandbox";
  readonly state?: IntegrationsState;
  readonly onNavigate?: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <AssistantIntegrationsField
      state={props.state ?? STATE}
      value={value}
      workspace={props.workspace ?? "host"}
      onNavigate={props.onNavigate ?? vi.fn()}
      onChange={(next) => {
        setValue(next);
        props.onChange(next);
      }}
      provider={{
        instanceId: "claude",
        driverKind: props.driverKind,
        displayName: props.driverKind === "opencode" ? "OpenCode" : "Claude",
      }}
    />
  );
}

it("Choose… starts from what All connected gave, then each checkmark edits the list", async () => {
  const onChange = vi.fn();
  await using _screen = await render(
    <Harness initial={{ mode: "all" }} onChange={onChange} driverKind="claudeAgent" />,
    { router: false },
  );
  await expect.element(page.getByRole("radio", { name: "All connected" })).toBeChecked();
  expect(page.getByRole("checkbox").query()).toBeNull();
  await userEvent.click(page.getByRole("radio", { name: "Choose…" }));
  expect(onChange).toHaveBeenLastCalledWith({ mode: "selected", names: ["linear", "notion"] });
  await expect.element(page.getByText("Needs sign-in")).toBeVisible();
  // Loaded natively in this Claude instance: always on, so not a choice.
  await expect.element(page.getByRole("checkbox", { name: "GitHub" })).toBeDisabled();
  await expect
    .element(page.getByText("Always on for Claude (set up in Claude Code)"))
    .toBeVisible();
  await userEvent.click(page.getByRole("checkbox", { name: "Notion" }));
  expect(onChange).toHaveBeenLastCalledWith({ mode: "selected", names: ["linear"] });
  await userEvent.click(page.getByRole("radio", { name: "All connected" }));
  expect(onChange).toHaveBeenLastCalledWith({ mode: "all" });
});

it("points to Settings → Integrations when Choose… has nothing to list", async () => {
  const onNavigate = vi.fn();
  await using _screen = await render(
    <Harness
      initial={{ mode: "selected", names: [] }}
      onChange={vi.fn()}
      onNavigate={onNavigate}
      driverKind="claudeAgent"
      state={{ ...STATE, integrations: [], detected: [] }}
    />,
  );
  await expect.element(page.getByText(/^No integrations to choose yet\./)).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Settings → Integrations" }))
    .toHaveAttribute("href", "/settings/integrations");
  await userEvent.click(page.getByRole("link", { name: "Settings → Integrations" }));
  expect(onNavigate).toHaveBeenCalledOnce();
});

it("says integrations stay out of work the assistant runs in the sandbox", async () => {
  await using _screen = await render(
    <Harness
      initial={{ mode: "all" }}
      onChange={vi.fn()}
      driverKind="claudeAgent"
      workspace="sandbox"
    />,
    { router: false },
  );
  await expect.element(page.getByText("Not available in the sandbox")).toBeVisible();
});

it("says when the assistant's provider cannot use integrations", async () => {
  await using _screen = await render(
    <Harness
      initial={{ mode: "selected", names: ["linear"] }}
      onChange={vi.fn()}
      driverKind="opencode"
    />,
    { router: false },
  );
  await expect.element(page.getByText("Not available on OpenCode")).toBeVisible();
  await expect.element(page.getByRole("checkbox", { name: "Linear" })).toBeDisabled();
});

it("compares selections by mode and names, in any order", () => {
  expect(sameIntegrations({ mode: "all" }, { mode: "all" })).toBe(true);
  expect(
    sameIntegrations(
      { mode: "selected", names: ["a", "b"] },
      { mode: "selected", names: ["b", "a"] },
    ),
  ).toBe(true);
  expect(sameIntegrations({ mode: "selected", names: ["a"] }, { mode: "all" })).toBe(false);
  expect(
    sameIntegrations({ mode: "selected", names: ["a"] }, { mode: "selected", names: ["b"] }),
  ).toBe(false);
});

it("chips list what the assistant gets, with a warning on any that needs attention", async () => {
  mocks.state = STATE;
  await using _screen = await render(
    <AssistantIntegrationChips
      environmentId={"env" as EnvironmentId}
      selection={{ mode: "selected", names: ["linear", "notion"] }}
    />,
    { router: false },
  );
  const list = page.getByRole("list", { name: "Integrations" });
  await expect.element(list.getByText("Linear · Connected")).toBeVisible();
  await expect
    .element(list.getByText("Notion · Needs sign-in"))
    .toHaveClass(/text-warning-foreground/);
  await expect
    .element(list.getByText("Linear · Connected"))
    .not.toHaveClass(/text-warning-foreground/);
});

it("chips stay away without the integrations capability", async () => {
  mocks.state = null;
  await using screen = await render(
    <AssistantIntegrationChips
      environmentId={"env" as EnvironmentId}
      selection={{ mode: "all" }}
    />,
    { router: false },
  );
  expect(screen.container.textContent).toBe("");
});
