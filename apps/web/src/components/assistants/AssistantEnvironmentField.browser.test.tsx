import type { AssistantEnvironmentPreference, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";

vi.mock("../../state/peerLinks", async () => {
  const { Atom } = await import("effect/reactivity");
  const offered = Atom.make(true);
  return { offersLinkedEnvironmentsAtom: () => offered, peerLinkEnvironment: { list: () => null } };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { links: [{ environmentId: "devbox-env", label: "devbox", status: "reachable" }] },
  }),
}));
vi.mock("../../state/environments", () => ({ useEnvironmentIdentities: () => [] }));

const { AssistantEnvironmentField } = await import("./AssistantEnvironmentField");

const renderField = (
  props: Partial<Parameters<typeof AssistantEnvironmentField>[0]> & {
    readonly onChange: (value: AssistantEnvironmentPreference | null) => void;
  },
) =>
  render(
    <AssistantEnvironmentField
      environmentId={"server-env" as EnvironmentId}
      value={null}
      workspace="host"
      scope="all"
      {...props}
    />,
  );

describe("AssistantEnvironmentField", () => {
  it("writes the picked machine, Auto, and clears back to Local", async () => {
    const onChange = vi.fn();
    await using screen = await renderField({ onChange });
    const trigger = page.getByRole("combobox", { name: "Default environment" });
    await expect.element(trigger).toHaveTextContent("Local");
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("option", { name: "devbox" }));
    expect(onChange).toHaveBeenLastCalledWith("devbox-env");
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("option", { name: /Auto/ }));
    expect(onChange).toHaveBeenLastCalledWith("auto");

    await screen.rerender(
      <AssistantEnvironmentField
        environmentId={"server-env" as EnvironmentId}
        value={"devbox-env" as EnvironmentId}
        workspace="host"
        scope="all"
        onChange={onChange}
      />,
    );
    await expect.element(trigger).toHaveTextContent("devbox");
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("option", { name: /Local/ }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it.each([
    {
      name: "sandbox",
      workspace: "sandbox" as const,
      scope: "all" as const,
      shown: "Sandbox container",
    },
    { name: "project", workspace: "host" as const, scope: "project" as const, shown: "Local" },
  ])("is disabled for a $name assistant", async ({ workspace, scope, shown }) => {
    await using _screen = await renderField({ workspace, scope, onChange: vi.fn() });
    const trigger = page.getByRole("combobox", { name: "Default environment" });
    await expect.element(trigger).toBeDisabled();
    await expect.element(trigger).toHaveTextContent(shown);
  });
});
