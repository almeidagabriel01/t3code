import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
    /** Builds the image when missing, then creates or starts the container; repeating it changes nothing. */
    readonly ensure: Effect.Effect<AssistantSandboxStatus, AssistantSandboxError>;
    readonly stop: Effect.Effect<AssistantSandboxStatus, AssistantSandboxError>;
    /** Removes the container; its volumes (the sandbox's T3 home and workspace) go only when asked. */
    readonly remove: (input: {
      readonly deleteVolumes: boolean;
    }) => Effect.Effect<AssistantSandboxStatus, AssistantSandboxError>;
    /** A one-time pairing credential minted inside the running container. Never logged. */
    readonly pairingCredential: Effect.Effect<Redacted.Redacted<string>, AssistantSandboxError>;
  }
>()("t3/assistants/AssistantSandbox") {}

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
  "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*",
  `RUN mkdir -p ${HOME} ${WORKSPACE} /opt/t3 && chown -R node:node ${HOME} ${WORKSPACE} /opt/t3`,
  "WORKDIR /opt/t3",
  "USER node",
  "COPY --chown=node:node package.json ./",
  "RUN npm install --omit=dev --no-audit --no-fund",
  "COPY --chown=node:node dist ./dist",
  `ENV T3CODE_HOME=${HOME} T3CODE_NO_BROWSER=1`,
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
const sandboxRunArgs = (name: string, image: string, sharedDir: string) => [
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
            const version = yield* Effect.try(
              () => (require(`${name}/package.json`) as { version: string }).version,
            ).pipe(Effect.option);
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

    const ensure = Effect.fn("AssistantSandbox.ensure")(function* () {
      yield* requireDocker();
      const containerName = yield* name;
      const current = yield* read();
      if (current.state === "running" || current.state === "starting") return current;
      if (current.state === "stopped") {
        yield* dockerOrFail("start the sandbox", ["start", containerName]);
        return yield* read();
      }
      const bundle = yield* source.resolve;
      const descriptor = yield* environment.getDescriptor;
      const image = sandboxImageTag(descriptor.serverVersion, bundle);
      yield* buildImage(image, bundle);
      yield* dockerOrFail("create the sandbox", sandboxRunArgs(containerName, image, sharedDir));
      return yield* read();
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

    return AssistantSandbox.of({
      status: read(),
      ensure: lock.withPermits(1)(ensure()),
      stop: lock.withPermits(1)(stop()),
      remove: Effect.fn("AssistantSandbox.remove")((input) => lock.withPermits(1)(remove(input))),
      pairingCredential: pairingCredential(),
    });
  }),
);
