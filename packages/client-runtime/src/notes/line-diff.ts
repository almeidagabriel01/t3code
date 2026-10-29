export interface NoteDiffLine {
  readonly text: string;
  readonly kind: "unchanged" | "added" | "removed";
}

// Bound both the quadratic LCS table and the number of rendered line rows.
const MAX_LCS_CELLS = 250_000;
const MAX_DIFF_LINES = 2_000;
const MAX_DIFF_CHARACTERS = 128_000;

/** Compare the server baseline with the local draft without normalizing either version. */
export function diffNoteLines(localBody: string, serverBody: string) {
  const local = localBody === "" ? [] : localBody.split("\n", MAX_DIFF_LINES + 1);
  const server = serverBody === "" ? [] : serverBody.split("\n", MAX_DIFF_LINES + 1);
  if (
    localBody.length + serverBody.length > MAX_DIFF_CHARACTERS ||
    local.length > MAX_DIFF_LINES ||
    server.length > MAX_DIFF_LINES ||
    (local.length + 1) * (server.length + 1) > MAX_LCS_CELLS
  ) {
    return {
      local: [{ text: localBody, kind: localBody === serverBody ? "unchanged" : "added" }],
      server: [{ text: serverBody, kind: localBody === serverBody ? "unchanged" : "removed" }],
      wholeBlock: true,
    } satisfies { local: NoteDiffLine[]; server: NoteDiffLine[]; wholeBlock: boolean };
  }
  const width = server.length + 1;
  const lengths = new Uint32Array((local.length + 1) * width);
  for (let p = local.length - 1; p >= 0; p--) {
    for (let h = server.length - 1; h >= 0; h--) {
      lengths[p * width + h] =
        local[p] === server[h]
          ? lengths[(p + 1) * width + h + 1]! + 1
          : Math.max(lengths[(p + 1) * width + h]!, lengths[p * width + h + 1]!);
    }
  }
  const localLines: NoteDiffLine[] = [];
  const serverLines: NoteDiffLine[] = [];
  let p = 0;
  let h = 0;
  while (p < local.length || h < server.length) {
    if (p < local.length && h < server.length && local[p] === server[h]) {
      localLines.push({ text: local[p++]!, kind: "unchanged" });
      serverLines.push({ text: server[h++]!, kind: "unchanged" });
    } else if (
      p < local.length &&
      (h === server.length || lengths[(p + 1) * width + h]! >= lengths[p * width + h + 1]!)
    ) {
      localLines.push({ text: local[p++]!, kind: "added" });
    } else {
      serverLines.push({ text: server[h++]!, kind: "removed" });
    }
  }
  return { local: localLines, server: serverLines, wholeBlock: false };
}
