/**
 * Synthetic Codex/Claude memory sandboxes: buildMemoryImportFixture(profile, { seed?, files? }),
 * negative faults and a physical-growth workload. No provider CLI or installed home is consulted.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk/Git fixture uses Node directly, without application services.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk/Git fixture uses Node directly, without application services.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk/Git fixture uses Node directly, without application services.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type {
  ImportDiscoveredSlot,
  ImportSnapshot,
  ImportSourceFile,
  ImportSlot,
} from "./MemoryImportTypes.ts";

const MEMORY_IMPORT_FIXTURE_SEED = "wp5-fixture-v1";
const MEMORY_IMPORT_FIXTURE_CLOCK = "2026-10-13T00:00:00.000Z";
export const MEMORY_IMPORT_FIXTURE_PROFILES = [
  "codex-handbook-v1",
  "codex-ad-hoc-v1",
  "claude-topic-v1",
  "claude-topic-metadata-v1",
] as const;
export type MemoryImportFixtureProfile = (typeof MEMORY_IMPORT_FIXTURE_PROFILES)[number];
export const MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS = {
  "codex-handbook-v1": "codex-handbook-v1",
  "codex-ad-hoc-v1": "codex-ad-hoc-v1",
  "claude-topic-v1": "claude-topic-v1",
  "claude-topic-metadata-v1": "claude-topic-metadata-v1",
} as const;

const digest = (bytes: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const sorted = (values: readonly string[]) => [...values].sort();
const write = (path: string, bytes: string | Buffer) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(path, bytes, { mode: 0o600 });
};
const safeSelector = (selector: string) => {
  if (
    !selector ||
    Buffer.byteLength(selector) > 512 ||
    selector.includes("\\") ||
    selector.includes("\0") ||
    selector.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error("Invalid synthetic fixture selector");
  }
};

export type MemoryImportFixture = {
  readonly sandbox: string;
  readonly trustedRoot: string;
  readonly sourceRoot: string;
  readonly stateDir: string;
  readonly emptyHome: string;
  readonly seed: string;
  readonly clockSeed: typeof MEMORY_IMPORT_FIXTURE_CLOCK;
  readonly profile: MemoryImportFixtureProfile;
  readonly snapshot: ImportSnapshot;
  readonly discovered: ImportDiscoveredSlot;
};

/** Pure snapshot cloning: raw text is intentionally unvalidated for negative parser tests. */
export const snapshotMemoryImportFiles = (
  snapshot: ImportSnapshot,
  files: readonly ImportSourceFile[],
): ImportSnapshot => ({
  ...snapshot,
  files: [...files],
  snapshotDigest: digest(
    JSON.stringify([
      snapshot.format,
      snapshot.profile,
      snapshot.parserVersion,
      null,
      files.map((file) => [file.selector, file.text, file.byteCount]),
    ]),
  ),
});

const defaultFiles = (
  profile: MemoryImportFixtureProfile,
  seed: string,
): Record<string, string> => {
  const body = `Use the synthetic ${digest(seed).slice(0, 12)} fixture guidance.\n`;
  switch (profile) {
    case "codex-handbook-v1":
      return {
        "MEMORY.md": `# Task Group: Fixture guidance\nscope: synthetic fixture task\n\n## Task 1: Stable guidance\n\n### learnings\n- ${body}`,
      };
    case "codex-ad-hoc-v1":
      return { "extensions/ad_hoc/notes/2026-10-13-fixture.md": body };
    case "claude-topic-v1":
      return {
        "fixture.md": `---\nname: Fixture guidance\ndescription: Synthetic direct topic\ntype: project\n---\n${body}`,
      };
    case "claude-topic-metadata-v1":
      return {
        "fixture.md": `---\nname: Fixture guidance\ndescription: Synthetic metadata topic\nmetadata:\n  type: project\n  node_type: memory\n  originSessionId: synthetic-session\n---\n${body}`,
      };
  }
};

export const buildMemoryImportFixture = Effect.fn("buildMemoryImportFixture")(function* (
  profile: MemoryImportFixtureProfile,
  options: { readonly seed?: string; readonly files?: Readonly<Record<string, string>> } = {},
) {
  const sandbox = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeFS.mkdtempSync(
        NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "goat-memory-import-fixture-"),
      ),
    ),
    (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
  );
  return yield* Effect.sync(() => {
    NodeFS.chmodSync(sandbox, 0o700);
    const seed = options.seed ?? MEMORY_IMPORT_FIXTURE_SEED;
    const trustedRoot = NodePath.join(sandbox, "trusted", "provider");
    const sourceRoot = profile.startsWith("codex-")
      ? NodePath.join(trustedRoot, "memories")
      : NodePath.join(trustedRoot, "fixture-selection", "memory");
    const stateDir = NodePath.join(sandbox, "state");
    const emptyHome = NodePath.join(sandbox, "empty-home");
    for (const path of [sourceRoot, stateDir, emptyHome])
      NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
    const files = { ...(options.files ?? defaultFiles(profile, seed)) };
    for (const [selector, text] of Object.entries(files)) {
      safeSelector(selector);
      write(NodePath.join(sourceRoot, selector), text);
    }
    const format = profile.startsWith("codex-") ? "codex" : "claude";
    const slot: ImportSlot = {
      format,
      rootSlot: "fixture-root",
      selection: format === "codex" ? null : "fixture-selection",
    };
    const parserVersion = MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS[profile];
    const sourceLocator = `fixture/${profile}`;
    // Excluded files exercise selection without changing the pinned commit or parser snapshot.
    if (format === "codex") {
      write(NodePath.join(sourceRoot, "memory_summary.md"), "Excluded synthetic summary\n");
      write(NodePath.join(sourceRoot, "raw_memories.md"), "Excluded synthetic raw data\n");
    } else {
      write(NodePath.join(sourceRoot, "MEMORY.md"), "Navigation only; fixture.md\n");
      write(NodePath.join(sourceRoot, "nested", "excluded.md"), "Excluded nested topic\n");
    }
    const snapshot = snapshotMemoryImportFiles(
      {
        slot,
        format,
        parserVersion,
        profile,
        sourceLocator,
        snapshotDigest: "",
        files: [],
      },
      sorted(Object.keys(files)).map((selector) => ({
        selector,
        text: files[selector]!,
        byteCount: Buffer.byteLength(files[selector]!),
      })),
    );
    const discovered: ImportDiscoveredSlot = {
      slot,
      parserVersion,
      profile,
      sourceLocator,
      label: `Synthetic ${profile}`,
    };
    return {
      sandbox,
      trustedRoot,
      sourceRoot,
      stateDir,
      emptyHome,
      seed,
      clockSeed: MEMORY_IMPORT_FIXTURE_CLOCK,
      profile,
      snapshot,
      discovered,
    } satisfies MemoryImportFixture;
  });
});

/** Stable byte/inventory capture; lstat + readlink means links are recorded, never traversed. */
export const captureMemoryImportInventory = (root: string) => {
  const entries: {
    path: string;
    kind: string;
    mode: number;
    bytes?: number;
    hash?: string;
    target?: string;
  }[] = [];
  const visit = (relative: string) => {
    const path = NodePath.join(root, relative);
    const stat = NodeFS.lstatSync(path);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink())
      entries.push({ path: relative, kind: "symlink", mode, target: NodeFS.readlinkSync(path) });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory", mode });
      for (const child of sorted(NodeFS.readdirSync(path)))
        visit(relative ? `${relative}/${child}` : child);
    } else if (stat.isFile()) {
      const bytes = NodeFS.readFileSync(path);
      entries.push({
        path: relative,
        kind: "file",
        mode,
        bytes: bytes.length,
        hash: digest(bytes),
      });
    } else entries.push({ path: relative, kind: "other", mode });
  };
  visit("");
  return { entries, digest: digest(JSON.stringify(entries)) };
};

export type MemoryImportFixtureFault =
  | "symlink-root"
  | "symlink-ancestor"
  | "symlink-file"
  | "traversal"
  | "malformed-utf8"
  | "nul"
  | "oversized-file"
  | "secret-header";

/** Negative builder; byte faults rewrite the first source file, preserving the pre-fault snapshot. */
export const buildMemoryImportFault = (
  fixture: MemoryImportFixture,
  fault: MemoryImportFixtureFault,
) => {
  let root = fixture.trustedRoot;
  let slot = fixture.snapshot.slot;
  const first = fixture.snapshot.files[0];
  if (!first) throw new Error("Fault requires a nonempty synthetic fixture");
  const file = NodePath.join(fixture.sourceRoot, first.selector);
  const corrupt = (data: string | Buffer) => write(file, data);
  switch (fault) {
    case "symlink-root":
      root = NodePath.join(fixture.sandbox, "root-link");
      NodeFS.symlinkSync("trusted/provider", root);
      break;
    case "symlink-ancestor":
      NodeFS.renameSync(
        NodePath.join(fixture.sandbox, "trusted"),
        NodePath.join(fixture.sandbox, "trusted-real"),
      );
      NodeFS.symlinkSync("trusted-real", NodePath.join(fixture.sandbox, "trusted"));
      break;
    case "symlink-file":
      NodeFS.renameSync(file, `${file}.target`);
      NodeFS.symlinkSync(`${file.split("/").at(-1)}.target`, file);
      break;
    case "traversal":
      slot = { ...slot, selection: "../outside" };
      break;
    case "malformed-utf8":
      corrupt(Buffer.from([0xc3, 0x28]));
      break;
    case "nul":
      corrupt("Synthetic\0body\n");
      break;
    case "oversized-file":
      corrupt(Buffer.alloc(262_145, 0x61));
      break;
    case "secret-header":
      corrupt(`---\ndescription: -----BEGIN PRIVATE KEY-----\n---\nSafe synthetic body\n`);
      break;
  }
  return { root, slot };
};

/** 16 distinct exactly-4096-byte UTF-8 bodies, four stable aliases each; round changes bytes only. */
export const makeMemoryImportWorkload = (round = 0, seed = MEMORY_IMPORT_FIXTURE_SEED) => {
  if (!Number.isSafeInteger(round) || round < 0)
    throw new Error("Invalid synthetic workload round");
  return Array.from({ length: 16 }, (_, index) => {
    const prefix = `Synthetic memory ${index} round ${round} ${digest(seed)}\n`;
    const body = prefix + "x".repeat(4096 - Buffer.byteLength(prefix));
    return {
      body,
      aliases: Array.from({ length: 4 }, (_, alias) => `fixture/${index}/${alias}#body`),
    };
  });
};
