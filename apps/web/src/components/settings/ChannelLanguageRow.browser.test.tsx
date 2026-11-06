import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { ChannelLanguageRow } from "./ChannelLanguageRow";

const mocks = vi.hoisted(() => ({ language: "auto", update: vi.fn() }));

vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: (
    _id: string,
    select: (settings: { channelLanguage: string }) => unknown,
  ) => select({ channelLanguage: mocks.language }),
  useUpdateEnvironmentSettings: () => mocks.update,
}));

const environmentId = "env" as EnvironmentId;

it("shows the option's label, not its value, and saves the chosen language", async () => {
  mocks.language = "auto";
  mocks.update.mockClear();
  await using _screen = await render(
    <ChannelLanguageRow environmentId={environmentId} disabled={false} />,
    { router: false }, // the row reads settings only
  );
  await expect.element(page.getByText("Language", { exact: true })).toBeVisible();
  const trigger = page.getByRole("combobox", { name: "Language" });
  await expect.element(trigger).toHaveTextContent("Automatic (Mac language)");
  await userEvent.click(trigger);
  await userEvent.click(page.getByRole("option", { name: "Português (Brasil)" }));
  expect(mocks.update).toHaveBeenCalledWith({ channelLanguage: "pt-BR" });
});

it("cannot be changed while the environment is read-only", async () => {
  mocks.language = "pt-BR";
  await using _screen = await render(
    <ChannelLanguageRow environmentId={environmentId} disabled />,
    { router: false }, // the row reads settings only
  );
  await expect
    .element(page.getByRole("combobox", { name: "Language" }))
    .toHaveTextContent("Português (Brasil)");
  await expect.element(page.getByRole("combobox", { name: "Language" })).toBeDisabled();
});
