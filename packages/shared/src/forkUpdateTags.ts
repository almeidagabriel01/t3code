export type ForkUpdateChannel = "stable" | "nightly";

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-(nightly)\.(\d{8})\.(\d+))?$/;

/** Nightly desktop versions ship as a different app, so a fork on one follows nightly. */
export function inferChannel(desktopVersion: string): ForkUpdateChannel {
  return desktopVersion.includes("-nightly") ? "nightly" : "stable";
}

function key(tag: string, channel: ForkUpdateChannel): ReadonlyArray<number> | null {
  const match = TAG.exec(tag);
  if (match === null || (match[4] === "nightly") !== (channel === "nightly")) return null;
  return [match[1], match[2], match[3], match[5] ?? "0", match[6] ?? "0"].map(Number);
}

/** Newest tag of the channel. Preview and other tags never qualify. */
export function latestChannelTag(
  tags: ReadonlyArray<string>,
  channel: ForkUpdateChannel,
): string | null {
  let best: { tag: string; key: ReadonlyArray<number> } | null = null;
  for (const tag of tags) {
    const k = key(tag.trim(), channel);
    if (k === null) continue;
    const i = best === null ? 0 : k.findIndex((part, index) => part !== best!.key[index]);
    if (best === null || (i !== -1 && k[i]! > best.key[i]!)) best = { tag: tag.trim(), key: k };
  }
  return best?.tag ?? null;
}

/** App bundle (`T3 Code (Beta).app`) inside a mounted DMG volume; null unless exactly one. */
export function findAppBundle(entries: ReadonlyArray<string>): string | null {
  const apps = entries.filter((entry) => entry.endsWith(".app"));
  return apps.length === 1 ? apps[0]! : null;
}

/** Mount point from `hdiutil attach` output (last tab-separated column of the /Volumes line). */
export function parseMountPoint(stdout: string): string | null {
  const line = stdout.split("\n").findLast((candidate) => candidate.includes("/Volumes/"));
  return line?.split("\t").at(-1)?.trim() || null;
}
