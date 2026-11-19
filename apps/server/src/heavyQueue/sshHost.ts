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

const resolved = new Map<string, string | null>();

/** `sshHostname`, asked once per host for the life of the process. */
export const cachedSshHostname = (host: string) => {
  if (!resolved.has(host)) resolved.set(host, sshHostname(host));
  return resolved.get(host) ?? null;
};
