import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as NodeModule from "node:module";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";

export class AssistantSandboxError extends Schema.TaggedError<AssistantSandboxError>()(
  "AssistantSandboxError",
  {
    reason: Schema.Literals(["docker_unavailable", "bundle_missing", "docker_failed", "invalid"]),
    message: Schema.String,
  },
) {}

export type AssistantSandboxState =
  | "docker_unavailable"
  | "missing"
  | "stopped"
  | "starting"
  | "running";

export interface AssistantSandboxStatus {
  readonly state: AssistantSandboxState;
  /** Where the container's T3 server answers on this machine; null unless it is running. */
  readonly url: string | null;
}

/** The server build the image carries: its `dist` and the runtime packages it loads from disk. */
export interface SandboxBundle {
  readonly distDir: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

export class AssistantSandbox extends Context.Service<
  AssistantSandbox,
  {
    readonly status: Effect.Effect<AssistantSandboxStatus>;
    /**
     * Builds the image when missing, then creates or starts the container with `cpus` cores at most
     * (null: no limit); repeating it changes nothing.
     */
    readonly ensure: (
      cpus: number | null,
    ) => Effect.Effect<AssistantSandboxStatus, AssistantSandboxError>;
    /** Changes the limit of a container that exists, running or not; nothing to do without one. */
    readonly setCpus: (cpus: number | null) => Effect.Effect<void, AssistantSandboxError>;
    readonly stop: Effect.Effect<AssistantSandboxStatus, AssistantSandboxError>;
    /** Removes the container; its volumes (the sandbox's T3 home and workspace) go only when asked. */
    readonly remove: (input: {
      readonly deleteVolumes: boolean;
    }) => Effect.Effect<AssistantSandboxStatus, AssistantSandboxError>;
    /** A one-time pairing credential minted inside the running container. Never logged. */
    readonly pairingCredential: Effect.Effect<Redacted.Redacted<string>, AssistantSandboxError>;
    /** The GitHub account `gh` is signed in to there; null when signed out or not running. */
    readonly githubAccount: Effect.Effect<string | null>;
    /**
     * `gh`'s device sign-in there: completes `prompt` with the code to enter, then waits for the
     * user and sets git to use it. Returns the account. Interrupting it stops it there too.
     */
    readonly githubLogin: (
      prompt: Deferred.Deferred<GithubPrompt>,
    ) => Effect.Effect<string, AssistantSandboxError>;
    readonly githubLogout: Effect.Effect<void, AssistantSandboxError>;
  }
>()("t3/assistants/AssistantSandbox") {}

export interface GithubPrompt {
  readonly userCode: string;
  readonly verificationUri: string;
}

/** The server's own bundle: `dist` is where its entry file sits, or the build beside the sources. */
export class SandboxBundleSource extends Context.Service<
  SandboxBundleSource,
  { readonly resolve: Effect.Effect<SandboxBundle, AssistantSandboxError> }
>()("t3/assistants/AssistantSandbox/SandboxBundleSource") {}

const SERVER_PORT = 3773;
const NODE_IMAGE = "node:26-bookworm-slim";
const LABEL = "t3.assistant-sandbox";
const BUILD_TIMEOUT = "20 minutes";
const DOCKER_TIMEOUT = "30 seconds";
const HOME = "/home/t3";
/** A device code lasts 15 minutes. */
const GITHUB_LOGIN_TIMEOUT = "16 minutes";
const GITHUB_LOGIN_PID = "/tmp/t3-github-login.pid";
const WORKSPACE = "/workspace";
/** Packages the server loads from disk instead of bundling; keep aligned with scripts/lib/cli-external-packages.ts. */
const RUNTIME_PACKAGES = [
  "@cursor/sdk",
  "playwright-core",
  "node-pty",
  "ffi-rs",
  "@ff-labs/fff-node",
  "@napi-rs/keyring",
  "zod",
  "undici",
] as const;

/**
 * T3's settings file is written once so the linked-environments beta is on at the receiving end of
 * the link; a later change by the user is never overwritten.
 */
const START_SCRIPT = [
  `mkdir -p ${HOME}/userdata`,
  `[ -f ${HOME}/userdata/settings.json ] || echo '{"linkedEnvironmentsEnabled":true}' > ${HOME}/userdata/settings.json`,
  `exec node /opt/t3/dist/bin.mjs serve --host 0.0.0.0 --port ${SERVER_PORT} --base-dir ${HOME} ${WORKSPACE}`,
].join(" && ");

export const sandboxDockerfile = [
  `FROM ${NODE_IMAGE}`,
  // ssh lets git reach an SSH remote, or fall back to HTTPS when it has no key for it.
  // gh, from GitHub's own apt repository, is the sandbox's GitHub sign-in.
  'RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl python3 make g++ && mkdir -p -m 755 /etc/apt/keyrings && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*',
  `RUN mkdir -p ${HOME} ${WORKSPACE} /opt/t3 && chown -R node:node ${HOME} ${WORKSPACE} /opt/t3`,
  "WORKDIR /opt/t3",
  "USER node",
  "COPY --chown=node:node package.json ./",
  "RUN npm install --omit=dev --no-audit --no-fund",
  "COPY --chown=node:node dist ./dist",
  // HOME on the home volume, so provider and git sign-ins (~/.claude, ~/.codex) outlive the container.
  `ENV HOME=${HOME} T3CODE_HOME=${HOME} T3CODE_NO_BROWSER=1`,
  `EXPOSE ${SERVER_PORT}`,
  `CMD ["sh", "-c", ${JSON.stringify(START_SCRIPT)}]`,
  "",
].join("\n");

const sandboxPackageJson = (dependencies: Readonly<Record<string, string>>) =>
  JSON.stringify(
    { name: "t3-sandbox-runtime", private: true, type: "module", dependencies },
    null,
    2,
  );

/** The image tag follows the server version and everything the build is made of, so a new build never reuses a stale image. */
export const sandboxImageTag = (serverVersion: string, bundle: SandboxBundle) =>
  `t3-assistant-sandbox:${serverVersion}-${(Hash.string(sandboxDockerfile + sandboxPackageJson(bundle.dependencies)) >>> 0).toString(16)}`;

const sandboxContainerName = (environmentId: string) =>
  `t3-assistant-sandbox-${environmentId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;

/** Published on this machine's loopback only; Docker picks the host port. */
const sandboxRunArgs = (name: string, image: string, sharedDir: string, cpus: string | null) => [
  "run",
  "-d",
  "--name",
  name,
  "--label",
  `${LABEL}=1`,
  "--restart",
  "unless-stopped",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  ...(cpus === null ? [] : ["--cpus", cpus]),
  "-p",
  `127.0.0.1::${SERVER_PORT}`,
  "-v",
  `${name}-home:${HOME}`,
  "-v",
  `${name}-work:${WORKSPACE}`,
  // The sandbox's own T3 home is HOME, so this is the folder its server calls `shared`.
  "-v",
  `${sharedDir}:${HOME}/shared`,
  image,
];

const decodeIssued = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.NonEmptyString })),
);

const fail = (reason: AssistantSandboxError["reason"], message: string) =>
  new AssistantSandboxError({ reason, message });

/** The live bundle: this build's `dist` with the versions of the runtime packages installed beside it. */
export const bundleSourceLayer = (distDir: string) =>
  Layer.effect(
    SandboxBundleSource,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return SandboxBundleSource.of({
        resolve: Effect.gen(function* () {
          if (
            !(yield* fs
              .exists(path.join(distDir, "bin.mjs"))
              .pipe(Effect.orElseSucceed(() => false)))
          ) {
            return yield* fail(
              "bundle_missing",
              "The server build is not available here. Build it with `vp run --filter t3 build:bundle`, then start the sandbox again.",
            );
          }
          const require = NodeModule.createRequire(path.join(distDir, "bin.mjs"));
          const dependencies: Record<string, string> = {};
          for (const name of RUNTIME_PACKAGES) {
            const version = yield* Effect.try({
              try: () => (require(`${name}/package.json`) as { version: string }).version,
              catch: (cause) => new Cause.UnknownError(cause),
            }).pipe(Effect.option);
            if (version._tag === "Some") dependencies[name] = version.value;
          }
          return { distDir, dependencies };
        }),
      });
    }),
  );

export const layer = Layer.effect(
  AssistantSandbox,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const { sharedDir } = yield* ServerConfig;
    const source = yield* SandboxBundleSource;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const lock = yield* Semaphore.make(1);

    const docker = (
      args: ReadonlyArray<string>,
      timeout: Duration.Input = DOCKER_TIMEOUT,
      cwd?: string,
    ) =>
      runner.run({ command: "docker", args, timeout, ...(cwd === undefined ? {} : { cwd }) }).pipe(
        Effect.map((out) => ({
          ok: out.code === 0,
          stdout: out.stdout.trim(),
          stderr: out.stderr.trim(),
        })),
        Effect.orElseSucceed(() => ({ ok: false, stdout: "", stderr: "docker did not run" })),
      );
    const dockerOrFail = Effect.fn("AssistantSandbox.docker")(function* (
      what: string,
      args: ReadonlyArray<string>,
      timeout?: Duration.Input,
      cwd?: string,
    ) {
      const result = yield* docker(args, timeout, cwd);
      if (!result.ok) {
        return yield* fail(
          "docker_failed",
          `Docker could not ${what}. ${result.stderr.split("\n").at(-1) ?? ""}`.trim(),
        );
      }
      return result.stdout;
    });

    const name = environment.getEnvironmentId.pipe(Effect.map(sandboxContainerName));

    const read = Effect.fn("AssistantSandbox.read")(function* () {
      if (!(yield* docker(["version", "--format", "{{.Server.Version}}"])).ok) {
        return { state: "docker_unavailable", url: null } satisfies AssistantSandboxStatus;
      }
      const containerName = yield* name;
      const inspected = yield* docker(["inspect", "--format", "{{.State.Running}}", containerName]);
      if (!inspected.ok) return { state: "missing", url: null } satisfies AssistantSandboxStatus;
      if (inspected.stdout !== "true")
        return { state: "stopped", url: null } satisfies AssistantSandboxStatus;
      const published = yield* docker(["port", containerName, `${SERVER_PORT}/tcp`]);
      const hostPort = /127\.0\.0\.1:(\d+)/.exec(published.stdout)?.[1];
      if (!published.ok || hostPort === undefined)
        return { state: "starting", url: null } satisfies AssistantSandboxStatus;
      const url = `http://127.0.0.1:${hostPort}`;
      const answers = yield* http.get(`${url}/.well-known/t3/environment`).pipe(
        Effect.map((response) => response.status === 200),
        Effect.timeout("3 seconds"),
        Effect.orElseSucceed(() => false),
      );
      return answers
        ? ({ state: "running", url } satisfies AssistantSandboxStatus)
        : ({ state: "starting", url: null } satisfies AssistantSandboxStatus);
    });

    const requireDocker = Effect.fn("AssistantSandbox.requireDocker")(function* () {
      if ((yield* read()).state === "docker_unavailable") {
        return yield* fail("docker_unavailable", "Docker is not running on this machine.");
      }
    });

    const buildImage = Effect.fn("AssistantSandbox.buildImage")(function* (
      image: string,
      bundle: SandboxBundle,
    ) {
      if ((yield* docker(["image", "inspect", image])).ok) return;
      const dir = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-sandbox-" })
        .pipe(
          Effect.mapError(() => fail("docker_failed", "The sandbox image could not be prepared.")),
        );
      yield* Effect.all([
        fs.writeFileString(path.join(dir, "Dockerfile"), sandboxDockerfile),
        fs.writeFileString(path.join(dir, "package.json"), sandboxPackageJson(bundle.dependencies)),
        fs.copy(bundle.distDir, path.join(dir, "dist")),
      ]).pipe(
        Effect.mapError(() => fail("docker_failed", "The sandbox image could not be prepared.")),
      );
      yield* dockerOrFail("build the sandbox image", ["build", "-t", image, dir], BUILD_TIMEOUT);
    }, Effect.scoped);

    /**
     * `--cpus` for `cpus` cores at most. Docker refuses more than its own cores, which on a Mac are
     * the VM's, not the Mac's, so a larger limit means all of them.
     */
    const cpuLimit = Effect.fn("AssistantSandbox.cpuLimit")(function* (cpus: number | null) {
      const cores = Number(
        yield* dockerOrFail("read its CPU count", ["info", "--format", "{{.NCPU}}"]),
      );
      if (!Number.isInteger(cores) || cores < 1) {
        return yield* fail("docker_failed", "Docker did not report how many CPUs it has.");
      }
      return String(cpus === null ? cores : Math.min(cpus, cores));
    });

    /**
     * `docker update --cpus 0` changes nothing, so a limit is lifted by raising it to every core.
     * A container that never had one is left alone and keeps the cores Docker gains later.
     */
    const updateCpus = Effect.fn("AssistantSandbox.updateCpus")(function* (
      containerName: string,
      cpus: number | null,
    ) {
      if (cpus === null) {
        const limited = yield* dockerOrFail("read the sandbox CPU limit", [
          "inspect",
          "--format",
          "{{.HostConfig.NanoCpus}}",
          containerName,
        ]);
        if (Number(limited) === 0) return;
      }
      yield* dockerOrFail("set the sandbox CPU limit", [
        "update",
        "--cpus",
        yield* cpuLimit(cpus),
        containerName,
      ]);
    });

    const ensure = Effect.fn("AssistantSandbox.ensure")(function* (cpus: number | null) {
      yield* requireDocker();
      const containerName = yield* name;
      const current = yield* read();
      if (current.state === "running" || current.state === "starting") {
        yield* updateCpus(containerName, cpus);
        return current;
      }
      if (current.state === "stopped") {
        yield* updateCpus(containerName, cpus);
        yield* dockerOrFail("start the sandbox", ["start", containerName]);
        return yield* read();
      }
      const bundle = yield* source.resolve;
      const descriptor = yield* environment.getDescriptor;
      const image = sandboxImageTag(descriptor.serverVersion, bundle);
      yield* buildImage(image, bundle);
      const limit = cpus === null ? null : yield* cpuLimit(cpus);
      yield* dockerOrFail(
        "create the sandbox",
        sandboxRunArgs(containerName, image, sharedDir, limit),
      );
      return yield* read();
    });

    const setCpus = Effect.fn("AssistantSandbox.setCpus")(function* (cpus: number | null) {
      const current = yield* read();
      if (current.state === "docker_unavailable" || current.state === "missing") return;
      yield* updateCpus(yield* name, cpus);
    });

    const stop = Effect.fn("AssistantSandbox.stop")(function* () {
      const current = yield* read();
      if (current.state === "running" || current.state === "starting") {
        yield* dockerOrFail("stop the sandbox", ["stop", yield* name], "60 seconds");
      }
      return yield* read();
    });

    const remove = Effect.fn("AssistantSandbox.remove")(function* (input: {
      readonly deleteVolumes: boolean;
    }) {
      const current = yield* read();
      if (current.state === "docker_unavailable") return current;
      const containerName = yield* name;
      if (current.state !== "missing") {
        yield* dockerOrFail("remove the sandbox", ["rm", "-f", containerName], "60 seconds");
      }
      if (input.deleteVolumes) {
        yield* docker(["volume", "rm", `${containerName}-home`, `${containerName}-work`]);
      }
      return yield* read();
    });

    const pairingCredential = Effect.fn("AssistantSandbox.pairingCredential")(function* () {
      const current = yield* read();
      if (current.state !== "running") {
        return yield* fail("invalid", "The sandbox is not running.");
      }
      const out = yield* dockerOrFail("mint a pairing credential", [
        "exec",
        yield* name,
        "node",
        "/opt/t3/dist/bin.mjs",
        "auth",
        "pairing",
        "create",
        "--base-dir",
        HOME,
        "--json",
      ]);
      const issued = yield* decodeIssued(out).pipe(
        Effect.mapError(() =>
          fail("docker_failed", "The sandbox did not return a pairing credential."),
        ),
      );
      return Redacted.make(issued.credential);
    });

    // Only the account line is read: the rest of `gh auth status` names the token, masked.
    const githubAccount = Effect.gen(function* () {
      const out = yield* docker([
        "exec",
        yield* name,
        "gh",
        "auth",
        "status",
        "--hostname",
        "github.com",
        "--active",
      ]);
      return (
        /Logged in to github\.com account (\S+)/.exec(`${out.stdout}\n${out.stderr}`)?.[1] ?? null
      );
    });

    const githubLogin = Effect.fn("AssistantSandbox.githubLogin")(function* (
      prompt: Deferred.Deferred<GithubPrompt>,
    ) {
      const containerName = yield* name;
      const decoder = new TextDecoder();
      let said = "";
      const stop = docker([
        "exec",
        containerName,
        "sh",
        "-c",
        `kill "$(cat ${GITHUB_LOGIN_PID})" 2>/dev/null; rm -f ${GITHUB_LOGIN_PID}`,
      ]);
      // Without a terminal gh prints the code and the address instead of opening a browser.
      const out = yield* runner
        .run({
          command: "docker",
          args: [
            "exec",
            containerName,
            "sh",
            "-c",
            `echo $$ > ${GITHUB_LOGIN_PID}; exec gh auth login --hostname github.com --git-protocol https --web 2>&1`,
          ],
          timeout: GITHUB_LOGIN_TIMEOUT,
          timeoutBehavior: "timedOutResult",
          onStdoutChunk: (chunk) => {
            said += decoder.decode(chunk, { stream: true });
            const userCode = /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(said)?.[1];
            const verificationUri = /web browser: (https:\/\/\S+)/.exec(said)?.[1];
            if (userCode !== undefined && verificationUri !== undefined) {
              Deferred.doneUnsafe(prompt, Exit.succeed({ userCode, verificationUri }));
            }
          },
        })
        .pipe(
          Effect.mapError(() => fail("docker_failed", "Docker could not run the GitHub sign-in.")),
          Effect.onInterrupt(() => stop),
        );
      if (out.timedOut) {
        yield* stop;
        return yield* fail("invalid", "The code expired before it was entered. Sign in again.");
      }
      if (out.code === 127) {
        return yield* fail(
          "invalid",
          "This sandbox was built without GitHub sign-in. Remove it, keeping its files, and start it again.",
        );
      }
      if (out.code !== 0) {
        return yield* fail(
          "docker_failed",
          `GitHub sign-in did not finish. ${out.stdout.trim().split("\n").at(-1) ?? ""}`.trim(),
        );
      }
      yield* dockerOrFail("set git to use the GitHub sign-in", [
        "exec",
        containerName,
        "gh",
        "auth",
        "setup-git",
        "--hostname",
        "github.com",
      ]);
      return /Logged in as (\S+)/.exec(said)?.[1] ?? (yield* githubAccount) ?? "GitHub";
    });

    const githubLogout = Effect.gen(function* () {
      const out = yield* docker([
        "exec",
        yield* name,
        "gh",
        "auth",
        "logout",
        "--hostname",
        "github.com",
      ]);
      // Already signed out is what was asked for.
      if (!out.ok && (yield* githubAccount) !== null) {
        return yield* fail("docker_failed", "GitHub sign-out did not finish.");
      }
    });

    return AssistantSandbox.of({
      status: read(),
      ensure: Effect.fn("AssistantSandbox.ensureExclusive")((cpus: number | null) =>
        lock.withPermits(1)(ensure(cpus)),
      ),
      setCpus: Effect.fn("AssistantSandbox.setCpusExclusive")((cpus: number | null) =>
        lock.withPermits(1)(setCpus(cpus)),
      ),
      stop: lock.withPermits(1)(stop()),
      remove: Effect.fn("AssistantSandbox.remove")((input) => lock.withPermits(1)(remove(input))),
      pairingCredential: pairingCredential(),
      githubAccount,
      githubLogin,
      githubLogout,
    });
  }),
);
