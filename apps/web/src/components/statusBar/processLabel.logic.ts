const INTERPRETERS = new Set(["node", "bun", "deno", "python", "ruby"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
const PACKAGE_RUNNERS = new Set(["npx", "pnpm", "vp"]);
const RUNNER_VERBS = new Set(["run", "exec", "dlx", "x"]);
// Inline code is not a file name: label the interpreter itself.
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);

const basename = (path: string) => path.split(/[\\/]/).findLast((part) => part !== "") ?? path;

const tokenize = (command: string) =>
  Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (m) => m[1] ?? m[2] ?? m[3] ?? "");

/** `/x/node_modules/vite/bin/vite.js` is "vite"; any other path is its file name. */
function scriptLabel(arg: string): string {
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(arg.replaceAll("\\", "/"));
  return pkg?.[1] ?? basename(arg);
}

const CHROMIUM_PROCESS_TYPES: Record<string, string> = {
  "gpu-process": "GPU process",
  renderer: "Renderer",
  zygote: "Zygote",
  "crashpad-handler": "Crash reporter",
};

const flagValue = (args: ReadonlyArray<string>, flag: string) =>
  args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);

/** Electron and Chromium helpers share one executable name; `--type` says what each one does. */
function chromiumHelperLabel(args: ReadonlyArray<string>): string | undefined {
  const type = flagValue(args, "--type");
  if (type === undefined) return undefined;
  if (type !== "utility") return CHROMIUM_PROCESS_TYPES[type] ?? `${type} process`;
  // `network.mojom.NetworkService` is "Network service".
  const service = flagValue(args, "--utility-sub-type")
    ?.split(".")
    .at(-1)
    ?.replace(/Service$/, "");
  if (!service) return "Utility process";
  const words = service.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return `${words[0]!.toUpperCase()}${words.slice(1)} service`;
}

/** What the process is for a human: the script or package an interpreter runs, else the executable. Never throws. */
export function processLabel(process: { readonly name: string; readonly command: string }): string {
  const tokens = tokenize(process.command);
  const exe = basename(process.name || tokens[0] || "");
  const args = tokens.slice(1);
  const fallback = exe || process.command;
  // macOS names the framework binary "Python"; Linux has "python3.12"; Windows adds ".exe".
  const kind = exe
    .toLowerCase()
    .replace(/\.exe$/, "")
    .replace(/^python[\d.]*$/, "python");
  if (/helper|electron|chrom/i.test(exe)) {
    const helper = chromiumHelperLabel(args);
    if (helper !== undefined) return helper;
  }
  if (SHELLS.has(kind)) {
    const flag = args.indexOf("-c");
    return (flag >= 0 ? args[flag + 1] : undefined) || fallback;
  }
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (PACKAGE_RUNNERS.has(kind)) {
    const words = RUNNER_VERBS.has(positional[0] ?? "") ? positional.slice(1) : positional;
    return words.slice(0, 3).join(" ") || fallback;
  }
  if (INTERPRETERS.has(kind)) {
    if (args.some((arg) => EVAL_FLAGS.has(arg))) return fallback;
    const module = args.indexOf("-m");
    if (module >= 0 && args[module + 1] !== undefined) return args[module + 1]!;
    const script = positional[0];
    return script === undefined ? fallback : scriptLabel(script);
  }
  return fallback;
}
