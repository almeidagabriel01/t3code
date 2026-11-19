import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  assistants: [] as unknown[],
  teams: [] as unknown[],
  target: null as null | {
    environmentId: string;
    teamId: string | null;
    defaultEnvironmentDraft?: unknown;
  },
  linksEnabled: true,
  links: undefined as
    | undefined
    | { links: Array<{ environmentId: string; label: string; status: string }> },
  listed: [] as unknown[],
  canAct: true,
  update: vi.fn(),
  alert: vi.fn(),
  goBack: vi.fn(),
  setDraft: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <p>{props.children}</p>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: { title: string; children?: ReactNode }) => (
    <main>
      <h1>{props.title}</h1>
      {props.children}
    </main>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../components/ui/ListRow", () => ({
  ListRow: (props: {
    label: string;
    detail?: string;
    description?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {[props.label, props.description, props.detail].filter(Boolean).join(" | ")}
    </button>
  ),
}));
vi.mock("../../components/ui/SelectionRow", () => ({
  SelectionRow: (props: {
    title: string;
    subtitle?: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.title}
    </button>
  ),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: mocks.goBack }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.target }));
vi.mock("./assistantTeamTarget", () => ({
  assistantTeamTargetAtom: {},
  setGroupDefaultEnvironmentDraft: mocks.setDraft,
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: mocks.assistants.map((assistant) => ({ environmentId: "hub", assistant })),
    archived: [],
    teams: mocks.teams,
  }),
  useAssistantActions: () => ({ canAct: mocks.canAct, update: mocks.update }),
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({
    environment: { capabilities: { peerLinks: true } },
    settings: { linkedEnvironmentsEnabled: mocks.linksEnabled },
  }),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/peerLinks", () => ({
  peerLinkEnvironment: { list: (request: unknown) => request },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (request: unknown) => {
    mocks.listed.push(request);
    return { data: request === null ? undefined : mocks.links };
  },
}));

import {
  AssistantEnvironmentPickerRouteScreen,
  AssistantEnvironmentRow,
  GroupEnvironmentPickerRouteScreen,
} from "./AssistantEnvironmentPicker";

let container: HTMLDivElement;
const mount = async (node: ReactNode) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { [Symbol.dispose]: () => act(() => root.unmount()) };
};
const showAssistant = (assistantId = "ada") =>
  mount(
    <AssistantEnvironmentPickerRouteScreen
      route={{ key: "k", name: "x", params: { environmentId: "hub", assistantId } } as never}
    />,
  );
const choices = () =>
  [...container.querySelectorAll('[role="radio"]')].map(
    (node) => `${node.textContent}${node.getAttribute("aria-checked") === "true" ? "*" : ""}`,
  );
const pick = (label: string) =>
  act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((node) => node.textContent === label)
      ?.click(),
  );
const assistant = (extra: object = {}) => ({
  id: "ada",
  workspace: "host",
  scope: "all",
  ...extra,
});

beforeEach(() => {
  Object.assign(mocks, {
    assistants: [assistant()],
    teams: [],
    target: null,
    linksEnabled: true,
    links: { links: [{ environmentId: "devbox", label: "devbox", status: "active" }] },
    listed: [],
    canAct: true,
  });
  for (const fn of [mocks.update, mocks.alert, mocks.goBack, mocks.setDraft]) fn.mockReset();
  mocks.update.mockResolvedValue({ ok: true, value: {} });
});

describe("assistant picker", () => {
  it("lists Local, the assistant server's links and Auto, and saves the pick at once", async () => {
    using _screen = await showAssistant();
    expect(container.querySelector("h1")?.textContent).toBe("Runs on");
    expect(mocks.listed).toContainEqual({ environmentId: "hub", input: {} });
    expect(choices()).toEqual(["Local*", "devbox", "Auto"]);
    await pick("devbox");
    expect(mocks.update).toHaveBeenCalledWith({ assistantId: "ada", defaultEnvironment: "devbox" });
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });

  it("picking what is already checked writes nothing", async () => {
    using _screen = await showAssistant();
    await pick("Local");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });

  it("a refusal stays on the picker and says why", async () => {
    mocks.update.mockResolvedValue({ ok: false, message: "Only in a user turn." });
    using _screen = await showAssistant();
    await pick("Auto");
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not change where work runs",
      "Only in a user turn.",
    );
    expect(mocks.goBack).not.toHaveBeenCalled();
  });

  it("with links off offers only Local and says why", async () => {
    mocks.linksEnabled = false;
    using _screen = await showAssistant();
    expect(choices()).toEqual(["Local*"]);
    expect(container.textContent).toContain("Linked environments are off on this machine");
    expect(mocks.listed.every((request) => request === null)).toBe(true);
  });

  it("holds every choice without write access", async () => {
    mocks.canAct = false;
    using _screen = await showAssistant();
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].every(
        (node) => node.disabled,
      ),
    ).toBe(true);
  });

  it("asks to open an assistant first when it is gone", async () => {
    using _screen = await showAssistant("gone");
    expect(container.textContent).toContain("Open an assistant first.");
  });
});

describe("group picker", () => {
  it("starts on the draft, offers each member's default, and picks into the draft", async () => {
    mocks.target = { environmentId: "hub", teamId: "crew", defaultEnvironmentDraft: "auto" };
    mocks.teams = [{ environmentId: "hub", team: { id: "crew", defaultEnvironment: "local" } }];
    using _screen = await mount(<GroupEnvironmentPickerRouteScreen />);
    expect(choices()).toEqual(["Each member's default", "Local", "devbox", "Auto*"]);
    await pick("Each member's default");
    expect(mocks.setDraft).toHaveBeenCalledWith(null);
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });

  it("picking the current value leaves the draft alone", async () => {
    mocks.target = { environmentId: "hub", teamId: "crew" };
    mocks.teams = [{ environmentId: "hub", team: { id: "crew" } }];
    using _screen = await mount(<GroupEnvironmentPickerRouteScreen />);
    await pick("Each member's default");
    expect(mocks.setDraft).not.toHaveBeenCalled();
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });

  it("asks to open a group first when none is chosen", async () => {
    using _screen = await mount(<GroupEnvironmentPickerRouteScreen />);
    expect(container.textContent).toContain("Open a group first.");
  });
});

describe("Runs on row", () => {
  const picker = (disabledReason: string | null) => ({
    current: "Local",
    disabledReason,
    notice: null,
    options: [],
  });

  it("opens when enabled", async () => {
    const onPress = vi.fn();
    using _screen = await mount(
      <AssistantEnvironmentRow picker={picker(null)} onPress={onPress} />,
    );
    await act(async () => container.querySelector("button")?.click());
    expect(onPress).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("Runs on | Local");
  });

  it("a fixed machine says why and does not open", async () => {
    const onPress = vi.fn();
    using _screen = await mount(
      <AssistantEnvironmentRow picker={picker("Fixed.")} icon="server.rack" onPress={onPress} />,
    );
    expect(container.textContent).toBe("Runs on | Fixed. | Local");
    expect(container.querySelector("button")?.disabled).toBe(true);
  });
});
