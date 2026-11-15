import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type PickerProps = {
  title: string;
  projectId: string;
  selected: unknown;
  onPick: (selection: unknown) => void;
  onClose: () => void;
};

const mocks = vi.hoisted(() => ({ goBack: vi.fn(), picker: null as PickerProps | null }));

vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: mocks.goBack }) }));
vi.mock("../settings/components/SettingsModelPicker", () => ({
  SettingsModelPicker: (props: PickerProps) => {
    mocks.picker = props;
    return null;
  },
}));

import {
  GroupMessageModelPickerRouteScreen,
  groupMessageModelAtom,
} from "./GroupMessageModelPickerRouteScreen";

const opus = { instanceId: "claudeAgent", model: "opus" };
const gpt = { instanceId: "codex", model: "gpt-5.5" };

it("picks the next message's model into the composer for its group and tab, saving nothing", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  const render = () =>
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <GroupMessageModelPickerRouteScreen
            route={
              {
                key: "k",
                name: "GroupMessageModel",
                params: {
                  environmentId: "hub",
                  projectId: "p1",
                  teamId: "g1",
                  tab: "project:p1",
                  selected: gpt,
                },
              } as never
            }
          />
        </RegistryContext.Provider>,
      ),
    );
  render();
  // It starts on what the chip shows.
  expect(mocks.picker).toMatchObject({
    title: "Model for this message",
    projectId: "p1",
    selected: gpt,
  });
  act(() => mocks.picker!.onPick(opus));
  const pickOf = (teamId: string) => registry.get(groupMessageModelAtom(teamId as never));
  expect(pickOf("g1")).toEqual({ tab: "project:p1", value: opus });
  expect(pickOf("g2")).toBeNull();
  expect(mocks.picker!.selected).toEqual(opus);
  // A pick made in another tab does not seed this one.
  act(() =>
    registry.set(groupMessageModelAtom("g1" as never), { tab: "all", value: opus } as never),
  );
  expect(mocks.picker!.selected).toEqual(gpt);
  mocks.picker!.onClose();
  expect(mocks.goBack).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
