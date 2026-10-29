// @effect-diagnostics-next-line nodeBuiltinImport:off -- acquisition validates absolute server paths.
import * as NodePath from "node:path";
import { MemoryImportRpcError, type MemoryImportIssue } from "@t3tools/contracts";
import { scanMemoryValue } from "../MemorySecretScanner.ts";
import type { MemoryImportReaderConfig } from "./MemoryImportReader.ts";

const error = (issue: MemoryImportIssue) => new MemoryImportRpcError({ issue });

export const safe = (value: string) => {
  if (
    !value ||
    Buffer.byteLength(value) > 512 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw error("path_rejected");
  if (scanMemoryValue(value).kind === "blocked") throw error("secret_detected");
};
export const absolute = (path: string) => {
  if (!NodePath.isAbsolute(path) || path === "/" || NodePath.normalize(path) !== path)
    throw error("path_rejected");
  safe(path.slice(NodePath.parse(path).root.length).split(NodePath.sep).join("/"));
};

export const validateStateBoundary = (config: MemoryImportReaderConfig) => {
  const within = (parent: string, path: string) => {
    const relative = NodePath.relative(parent, path);
    return (
      relative === "" ||
      (!NodePath.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`))
    );
  };
  for (const root of config.roots) {
    absolute(root.path);
    if (within(root.path, config.stateDir) || within(config.stateDir, root.path))
      throw error("path_rejected");
  }
};
