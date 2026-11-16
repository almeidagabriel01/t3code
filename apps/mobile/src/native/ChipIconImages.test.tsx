import { RegistryContext } from "@effect/atom-react";
import type { AssistantRobotLook } from "@t3tools/client-runtime/assistantRobot";
import { AssistantId } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  captures: [] as Array<AssistantRobotLook>,
  failingHue: -1,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Rect: () => null,
  Text: () => null,
}));
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({}) }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    readonly uri: string;
    constructor(...parts: Array<string>) {
      this.uri = parts.join("/");
    }
    create() {}
    async write() {}
  },
}));
vi.mock("../features/assistants/AssistantRobot", () => ({
  RobotDrawing: (props: { look: AssistantRobotLook; ref: (svg: unknown) => void }) => {
    useEffect(() =>
      props.ref({
        toDataURL: (done: (base64?: string) => void) => {
          native.captures.push(props.look);
          done(props.look.hue === native.failingHue ? undefined : `png-${props.look.hue}`);
        },
      }),
    );
    return null;
  },
}));

import {
  assistantFaceKey,
  ChipIconRasterizer,
  chipIconImageAtom,
  useAssistantFaceImages,
} from "./ChipIconImages";

const member = (id: string, hue: number) => ({
  id: AssistantId.make(id),
  avatar: { kind: "robot" as const, hue, variant: 1 },
});

function Faces(props: {
  readonly members: ReadonlyArray<ReturnType<typeof member>>;
  readonly onFaces: (faces: ReadonlyMap<string, string>) => void;
}) {
  props.onFaces(useAssistantFaceImages(props.members));
  return null;
}

it("draws each face once, draws a new look anew, and leaves a failed face to the glyph", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  using _frame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((frame) => {
    frame(0);
    return 0;
  });
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<ChipIconRasterizer />));
  const image = (look: AssistantRobotLook) =>
    new Promise<AsyncResult.AsyncResult<string, unknown>>((resolve) => {
      const cancel = registry.subscribe(
        chipIconImageAtom(assistantFaceKey(look)),
        (result) => {
          if (result._tag === "Initial") return;
          queueMicrotask(cancel);
          resolve(result);
        },
        { immediate: true },
      );
    });
  const face = (look: AssistantRobotLook) => act(() => image(look));

  native.failingHue = 5;
  const [first, again] = await act(() =>
    Promise.all([image({ hue: 210, variant: 1 }), image({ hue: 210, variant: 1 })]),
  );
  expect(first).toEqual(again);
  expect(AsyncResult.isSuccess(first) && first.value).toMatch(
    /^file:\/\/\/cache\/t3-chip-icons\/.+\.png$/,
  );
  expect(native.captures).toEqual([{ hue: 210, variant: 1 }]);

  const recoloured = await face({ hue: 30, variant: 1 });
  expect(AsyncResult.isSuccess(recoloured) && recoloured.value).not.toBe(
    AsyncResult.isSuccess(first) && first.value,
  );
  expect(native.captures).toHaveLength(2);

  expect(AsyncResult.isFailure(await face({ hue: 5, variant: 1 }))).toBe(true);

  let faces: ReadonlyMap<string, string> = new Map();
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Faces
          members={[member("ada", 210), member("bob", 5)]}
          onFaces={(next) => (faces = next)}
        />
      </RegistryContext.Provider>,
    ),
  );
  expect([...faces]).toEqual([["ada", AsyncResult.isSuccess(first) && first.value]]);
  await act(async () => root.unmount());
  registry.dispose();
});
