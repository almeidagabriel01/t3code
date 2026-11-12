import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { stored: undefined as unknown, save: vi.fn() },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.stored,
  useAtomSet: () => mocks.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "update",
}));

import type { Preferences } from "../../persistence/mobile-preferences";
import { useKanbanPanelPreferences } from "./useKanbanPanelPreferences";

const applied = (current: Preferences) =>
  (mocks.save.mock.lastCall![0] as { transform: (value: Preferences) => Preferences }).transform(
    current,
  );

it("reads nothing before preferences load, then each board's choices", () => {
  mocks.stored = AsyncResult.initial();
  expect(useKanbanPanelPreferences()).toMatchObject({ scopes: {}, collapsed: {} });
  mocks.stored = AsyncResult.success({
    kanbanPanel: { scopes: { "env:p1": "no-project" }, collapsed: { b1: { done: false } } },
  });
  expect(useKanbanPanelPreferences()).toMatchObject({
    scopes: { "env:p1": "no-project" },
    collapsed: { b1: { done: false } },
  });
});

it("saves a scope and a section fold without dropping the other choices", () => {
  mocks.stored = AsyncResult.initial();
  const current: Preferences = {
    kanbanPanel: { scopes: { a: "project" }, collapsed: { b1: { todo: true } } },
  };
  useKanbanPanelPreferences().setScope("b", "no-project");
  expect(applied(current)).toEqual({
    kanbanPanel: {
      scopes: { a: "project", b: "no-project" },
      collapsed: { b1: { todo: true } },
    },
  });
  useKanbanPanelPreferences().setCollapsed("b1", "done", false);
  expect(applied(current)).toEqual({
    kanbanPanel: {
      scopes: { a: "project" },
      collapsed: { b1: { todo: true, done: false } },
    },
  });
  useKanbanPanelPreferences().setCollapsed("b2", "todo", true);
  expect(applied({})).toEqual({ kanbanPanel: { collapsed: { b2: { todo: true } } } });
});
