import { useAtomValue } from "@effect/atom-react";
import {
  assistantRobotLook,
  type AssistantRobotLook,
} from "@t3tools/client-runtime/assistantRobot";
import type { Assistant, ProjectIconColor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { File, Paths } from "expo-file-system";
import { useRef, useSyncExternalStore } from "react";
import { Platform, View } from "react-native";
import Svg, { Rect, Text } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { RobotDrawing } from "../features/assistants/AssistantRobot";
import { countGlyphs, projectIconColorClassNames, type ProjectIconGlyph } from "../lib/projectIcon";

const TILE_SIZE = 48;

/** What a chip image draws: a project's glyph or an assistant's face. */
type ChipTile = ProjectIconGlyph | { readonly kind: "robot"; readonly look: AssistantRobotLook };

interface PendingTile {
  readonly key: string;
  readonly glyph: ChipTile;
  readonly promise: Promise<string>;
  readonly resolve: (uri: string) => void;
  readonly reject: () => void;
}

const tiles = new Map<string, PendingTile>();
let pendingTiles: ReadonlyArray<PendingTile> = [];
const listeners = new Set<() => void>();

export function projectGlyphKey(glyph: ProjectIconGlyph): string {
  return JSON.stringify(
    glyph.kind === "emoji" ? ["emoji", glyph.emoji] : ["monogram", glyph.text, glyph.color],
  );
}

/** Keyed by the face's look, so a new hue or variant draws a new image. */
export function assistantFaceKey(look: AssistantRobotLook): string {
  return JSON.stringify(["robot", look.hue, look.variant]);
}

function decodeTileKey(key: string): ChipTile {
  const [kind, first, second] = JSON.parse(key) as [string, string | number, string | number];
  if (kind === "robot") {
    return { kind: "robot", look: { hue: Number(first), variant: Number(second) } };
  }
  return kind === "emoji"
    ? { kind: "emoji", emoji: String(first) }
    : { kind: "monogram", text: String(first), color: second as ProjectIconColor };
}

function rasterize(key: string): Promise<string> {
  const existing = tiles.get(key);
  if (existing) return existing.promise;
  let resolve!: (uri: string) => void;
  let reject!: () => void;
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const tile = { key, glyph: decodeTileKey(key), promise, resolve, reject };
  tiles.set(key, tile);
  pendingTiles = [...pendingTiles, tile];
  queueMicrotask(notify);
  return promise;
}

// A file, not a data URI: Android's composer chips decode only files. Named by content, so a
// theme change never shows an image the native caches kept under the same URI.
async function writeTile(key: string, base64: string): Promise<string> {
  const name = [key, base64].map((part) => (Hash.string(part) >>> 0).toString(36)).join("-");
  const file = new File(Paths.cache, "t3-chip-icons", `${name}.png`);
  file.create({ intermediates: true, overwrite: true });
  await file.write(base64, { encoding: "base64" });
  return file.uri;
}

function finish(tile: PendingTile, base64: string | undefined) {
  pendingTiles = pendingTiles.filter((pending) => pending !== tile);
  notify();
  if (!base64) {
    tile.reject();
    return;
  }
  writeTile(tile.key, base64.replace(/\s/g, "")).then(tile.resolve, tile.reject);
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

class ChipIconRasterizeError extends Schema.TaggedError<ChipIconRasterizeError>()(
  "ChipIconRasterizeError",
  { key: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not rasterize the chip icon ${this.key}.`;
  }
}

export const chipIconImageAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.tryPromise({
      try: () => rasterize(key),
      catch: (cause) => new ChipIconRasterizeError({ key, cause }),
    }),
  ).pipe(Atom.keepAlive, Atom.withLabel(`mobile-chip-icon-image:${key}`)),
);

const faceImagesAtom = Atom.family((keys: string) =>
  Atom.make((get) => {
    const images = new Map<string, string>();
    for (const key of JSON.parse(keys) as ReadonlyArray<string>) {
      const uri = AsyncResult.getOrElse(get(chipIconImageAtom(key)), () => null);
      if (uri !== null) images.set(key, uri);
    }
    return images;
  }).pipe(Atom.withLabel(`mobile-assistant-face-images:${keys}`)),
);

/** Each member's face as a chip image, by member id; a member is missing until its image is ready. */
export function useAssistantFaceImages(
  members: ReadonlyArray<Pick<Assistant, "id" | "avatar">>,
): ReadonlyMap<string, string> {
  const keys = members.map((member) => assistantFaceKey(assistantRobotLook(member)));
  const images = useAtomValue(faceImagesAtom(JSON.stringify([...new Set(keys)].sort())));
  return new Map(
    members.flatMap((member, index) => {
      const uri = images.get(keys[index]!);
      return uri === undefined ? [] : [[member.id, uri] as const];
    }),
  );
}

export function ChipIconRasterizer() {
  const pending = useSyncExternalStore(subscribe, () => pendingTiles);
  return pending.map((tile) => <GlyphCapture key={tile.key} tile={tile} />);
}

function captureTile(svg: Svg, tile: PendingTile) {
  try {
    svg.toDataURL(
      (base64?: string) => finish(tile, base64),
      Platform.OS === "ios" ? { width: TILE_SIZE, height: TILE_SIZE } : undefined,
    );
  } catch {
    finish(tile, undefined);
  }
}

function GlyphCapture(props: { readonly tile: PendingTile }) {
  const started = useRef(false);
  const capture = (svg: Svg | null) => {
    if (!svg || started.current) return;
    started.current = true;
    requestAnimationFrame(() => captureTile(svg, props.tile));
  };
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", left: -TILE_SIZE * 4, top: 0, opacity: 0 }}
    >
      {props.tile.glyph.kind === "robot" ? (
        <RobotDrawing
          ref={capture}
          look={props.tile.glyph.look}
          face="idle"
          size={TILE_SIZE}
          beat={false}
        />
      ) : (
        <Svg ref={capture} width={TILE_SIZE} height={TILE_SIZE}>
          {props.tile.glyph.kind === "emoji" ? (
            <Text
              x={TILE_SIZE / 2}
              y={TILE_SIZE * 0.8}
              textAnchor="middle"
              fontSize={TILE_SIZE * 0.8}
            >
              {props.tile.glyph.emoji}
            </Text>
          ) : (
            <MonogramTile text={props.tile.glyph.text} color={props.tile.glyph.color} />
          )}
        </Svg>
      )}
    </View>
  );
}

function MonogramTile(props: { readonly text: string; readonly color: ProjectIconColor }) {
  const classNames = projectIconColorClassNames(props.color);
  const background = useResolveClassNames(classNames.background);
  const foreground = useResolveClassNames(`font-mono ${classNames.text}`);
  const fontSize = TILE_SIZE * (countGlyphs(props.text) === 1 ? 0.6 : 0.515625);
  return (
    <>
      <Rect
        width={TILE_SIZE}
        height={TILE_SIZE}
        rx={TILE_SIZE * 0.25}
        fill={String(background.backgroundColor)}
      />
      <Text
        x={TILE_SIZE / 2}
        y={TILE_SIZE / 2 + fontSize * 0.36}
        textAnchor="middle"
        fill={String(foreground.color)}
        fontFamily={typeof foreground.fontFamily === "string" ? foreground.fontFamily : undefined}
        fontWeight="700"
        fontSize={fontSize}
      >
        {props.text}
      </Text>
    </>
  );
}
