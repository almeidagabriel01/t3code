// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

/** The host ssh connects to for `host` (aliases and `HostName` applied), or null when ssh -G fails. */
export const sshHostname = (host: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  // It comes from an agent's command line: ssh would take `-oProxyCommand=…` as an option.
  if (host.startsWith("-")) return null;
  try {
    const result = NodeChildProcess.spawnSync("ssh", ["-G", host], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    if (result.status !== 0) return null;
    return /^hostname (\S+)$/m.exec(result.stdout)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
};

/** A failed lookup (ssh missing, a slow resolver) is asked again after this long. */
export const FAILED_LOOKUP_RETRY_MS = 60_000;

/**
 * `lookup`, asked once per host for the life of the process when it answers. A failure is kept
 * for `FAILED_LOOKUP_RETRY_MS` only: a passing one must not leave the Runner's host unmatched.
 */
export const cacheHostnames = (
  lookup: (host: string) => string | null,
  now: () => number = Date.now,
) => {
  const resolved = new Map<string, { readonly name: string | null; readonly at: number }>();
  return (host: string) => {
    const known = resolved.get(host);
    if (known !== undefined && (known.name !== null || now() - known.at < FAILED_LOOKUP_RETRY_MS)) {
      return known.name;
    }
    const name = lookup(host);
    resolved.set(host, { name, at: now() });
    return name;
  };
};

export const cachedSshHostname = cacheHostnames((host) => sshHostname(host));
