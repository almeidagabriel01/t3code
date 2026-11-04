const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
const PACKAGE_RUNNERS = new Set(["npx", "pnpm", "vp"]);
const RUNNER_VERBS = new Set(["run", "exec", "dlx", "x"]);

const basename = (path: string) => path.split(/[\\/]/).findLast((part) => part !== "") ?? path;

const tokenize = (command: string) =>
  Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (m) => m[1] ?? m[2] ?? m[3] ?? "");

/** `/x/node_modules/vite/bin/vite.js` is "vite"; any other path is its file name. */
function scriptLabel(arg: string): string {
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(arg.replaceAll("\\", "/"));
  return pkg?.[1] ?? basename(arg);
}

/** What the process is for a human: the script or package an interpreter runs, else the executable. Never throws. */
export function processLabel(process: { readonly name: string; readonly command: string }): string {
  const tokens = tokenize(process.command);
  const exe = basename(process.name || tokens[0] || "");
  const args = tokens.slice(1);
  const fallback = exe || process.command;
  if (SHELLS.has(exe)) {
    const flag = args.indexOf("-c");
    return (flag >= 0 ? args[flag + 1] : undefined) || fallback;
  }
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (PACKAGE_RUNNERS.has(exe)) {
    const words = RUNNER_VERBS.has(positional[0] ?? "") ? positional.slice(1) : positional;
    return words.slice(0, 3).join(" ") || fallback;
  }
  if (INTERPRETERS.has(exe)) {
    const script = positional[0];
    return script === undefined ? fallback : scriptLabel(script);
  }
  return fallback;
}
