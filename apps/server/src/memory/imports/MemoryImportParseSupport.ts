// @effect-diagnostics-next-line nodeBuiltinImport:off -- SHA-256 is deterministic pure computation, with no runtime service or I/O.
import * as NodeCrypto from "node:crypto";
import * as M from "@t3tools/contracts";
import { scanMemoryValue } from "../MemorySecretScanner.ts";
import type { ImportParsedItem, ImportSourceFile } from "./MemoryImportTypes.ts";

const FILE_MAX_BYTES = 256 * 1024;
const TITLE_MAX_CODE_POINTS = 256;
export const bytes = (s: string) => new TextEncoder().encode(s).length;
export const canonical = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n").trim();
export const hash = (s: string) => NodeCrypto.createHash("sha256").update(s).digest("hex");
export const secret = (s: string) => scanMemoryValue(s).kind === "blocked";
export const control = (s: string) =>
  [...s].some((c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127);
export const safeSelector = (s: string) =>
  s.length > 0 &&
  s === s.trim() &&
  bytes(s) <= M.MEMORY_IMPORT_KEY_MAX_UTF8_BYTES &&
  !control(s) &&
  !/[\\:#]/u.test(s) &&
  s.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** A single-line title: control characters and whitespace runs collapse, length is clamped. */
export const titleOf = (s: string) =>
  [
    ...canonical(s)
      .replace(/[\u0000-\u001f\u007f\s]+/gu, " ")
      .trim(),
  ]
    .slice(0, TITLE_MAX_CODE_POINTS)
    .join("");

/**
 * Why one file cannot be parsed at all, so only that file is skipped. Order matters: the
 * reader already marks files it could not copy, the rest are checked on the text itself.
 */
export const fileProblem = (file: ImportSourceFile): M.MemoryImportIssue | undefined => {
  if (file.skip) return file.skip;
  if (file.text.includes("\0")) return "unsupported_format";
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(file.text))
    return "invalid_utf8";
  if (bytes(file.text) > FILE_MAX_BYTES) return "limit_exceeded";
  if (secret(file.text)) return "secret_detected";
  return undefined;
};

export const rejectedRow = (
  sourceItemKey: string,
  byteCount: number,
  issue: M.MemoryImportIssue,
): ImportParsedItem => ({ kind: "rejected", sourceItemKey, byteCount, issue });
