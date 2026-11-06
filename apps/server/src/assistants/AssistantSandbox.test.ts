import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AssistantSandbox from "./AssistantSandbox.ts";

const CREDENTIAL = "SECRETCODE123";
const bundle: AssistantSandbox.SandboxBundle = {
  distDir: import.meta.dirname,
  dependencies: { zod: "4.6.5" },
};

type Docker = {
  available: boolean;
  image: boolean;
  container: "none" | "running" | "stopped";
  answers: boolean;
  calls: string[][];
  failing: string | null;
};

const harness = (initial: Partial<Docker> = {}, bundleFails = false) => {
  const docker: Docker = {
    available: true,
    image: false,
    container: "none",
    answers: true,
    calls: [],
    failing: null,
    ...initial,
  };
  const out = (stdout: string, code = 0, stderr = "") =>
    Effect.succeed({
      stdout,
      stderr,
      code: code as never,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) => {
      const args = [...input.args];
      docker.calls.push(args);
      if (!docker.available)
        return Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "docker",
            argumentCount: args.length,
            cause: "ENOENT",
          }),
        );
      if (args[0] === docker.failing) return out("", 1, "boom\nlast line");
      switch (args[0]) {
        case "version":
          return out("29.8.2\n");
        case "image":
          return docker.image ? out("[]") : out("", 1, "No such image");
        case "build":
          docker.image = true;
          return out("built");
        case "run":
          docker.container = "running";
          return out("abc123");
        case "start":
          docker.container = "running";
          return out("name");
        case "stop":
          docker.container = "stopped";
          return out("name");
        case "rm":
          docker.container = "none";
          return out("name");
        case "volume":
          return out("");
        case "inspect":
          return docker.container === "none"
            ? out("", 1, "No such object")
            : out(docker.container === "running" ? "true" : "false");
        case "port":
          return out("127.0.0.1:49153\n");
        case "exec":
          return out(JSON.stringify({ id: "x", credential: CREDENTIAL }));
        default:
          return out("", 1, "unknown");
      }
    },
  });
  const layer = AssistantSandbox.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, runner),
        Layer.succeed(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(
              EnvironmentId.make("77830f5d-56c5-4557-970c-034e47e484f6"),
            ),
            getDescriptor: Effect.succeed({
              serverVersion: "1.2.3",
            } as ExecutionEnvironmentDescriptor),
          }),
        ),
        Layer.succeed(
          AssistantSandbox.SandboxBundleSource,
          AssistantSandbox.SandboxBundleSource.of({
            resolve: bundleFails
              ? Effect.fail(
                  new AssistantSandbox.AssistantSandboxError({
                    reason: "bundle_missing",
                    message: "no build",
                  }),
                )
              : Effect.succeed(bundle),
          }),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("{}", { status: docker.answers ? 200 : 503 }),
              ),
            ),
          ),
        ),
        NodeServices.layer,
      ),
    ),
  );
  return { docker, layer };
};

const withSandbox = <A, E>(
  initial: Partial<Docker>,
  body: (
    sandbox: AssistantSandbox.AssistantSandbox["Service"],
    docker: Docker,
  ) => Effect.Effect<A, E>,
  bundleFails = false,
) => {
  const { docker, layer } = harness(initial, bundleFails);
  return Effect.gen(function* () {
    return yield* body(yield* AssistantSandbox.AssistantSandbox, docker);
  }).pipe(Effect.provide(layer));
};

const commands = (docker: Docker) => docker.calls.map((call) => call[0]);

describe("AssistantSandbox", () => {
  it.effect("reports docker missing, container states and a starting server", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* withSandbox({ available: false }, (s) => s.status), {
        state: "docker_unavailable",
        url: null,
      });
      assert.strictEqual((yield* withSandbox({}, (s) => s.status)).state, "missing");
      assert.strictEqual(
        (yield* withSandbox({ container: "stopped" }, (s) => s.status)).state,
        "stopped",
      );
      assert.deepStrictEqual(yield* withSandbox({ container: "running" }, (s) => s.status), {
        state: "running",
        url: "http://127.0.0.1:49153",
      });
      assert.deepStrictEqual(
        yield* withSandbox({ container: "running", answers: false }, (s) => s.status),
        { state: "starting", url: null },
      );
    }),
  );

  it.effect("ensure builds once, publishes on loopback only, and repeats without effect", () =>
    withSandbox({}, (s, docker) =>
      Effect.gen(function* () {
        const first = yield* s.ensure;
        assert.strictEqual(first.state, "running");
        const run = docker.calls.find((call) => call[0] === "run")!;
        assert.include(run, "127.0.0.1::3773");
        assert.include(run, "unless-stopped");
        assert.include(run.join(" "), "t3-assistant-sandbox-77830f5d-home:/home/t3");
        assert.include(run.join(" "), "t3-assistant-sandbox-77830f5d-work:/workspace");
        assert.isTrue(run.at(-1)!.startsWith("t3-assistant-sandbox:1.2.3-"));
        const before = docker.calls.length;
        yield* s.ensure;
        assert.deepStrictEqual(
          commands(docker)
            .slice(before)
            .filter((c) => c === "run" || c === "build" || c === "start"),
          [],
        );
        assert.strictEqual(commands(docker).filter((c) => c === "build").length, 1);
      }),
    ),
  );

  it.effect("ensure reuses an existing image and starts a stopped container", () =>
    Effect.gen(function* () {
      yield* withSandbox({ image: true }, (s, docker) =>
        Effect.gen(function* () {
          yield* s.ensure;
          assert.notInclude(commands(docker), "build");
        }),
      );
      yield* withSandbox({ container: "stopped" }, (s, docker) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* s.ensure).state, "running");
          assert.include(commands(docker), "start");
          assert.notInclude(commands(docker), "run");
        }),
      );
    }),
  );

  it.effect("ensure fails with a reason when docker or the build is unavailable", () =>
    Effect.gen(function* () {
      const noDocker = yield* withSandbox({ available: false }, (s) => s.ensure.pipe(Effect.flip));
      assert.strictEqual(noDocker.reason, "docker_unavailable");
      const noBundle = yield* withSandbox({}, (s) => s.ensure.pipe(Effect.flip), true);
      assert.strictEqual(noBundle.reason, "bundle_missing");
      const failed = yield* withSandbox({ failing: "build" }, (s) => s.ensure.pipe(Effect.flip));
      assert.strictEqual(failed.reason, "docker_failed");
      assert.include(failed.message, "last line");
    }),
  );

  it.effect("stop and remove move through the states, keeping volumes unless asked", () =>
    withSandbox({ container: "running" }, (s, docker) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* s.stop).state, "stopped");
        assert.strictEqual((yield* s.remove({ deleteVolumes: false })).state, "missing");
        assert.notInclude(commands(docker), "volume");
        assert.strictEqual((yield* s.remove({ deleteVolumes: true })).state, "missing");
        assert.include(commands(docker), "volume");
        assert.strictEqual((yield* s.stop).state, "missing");
      }),
    ),
  );

  it.effect("remove does nothing when docker is gone", () =>
    withSandbox({ available: false }, (s) =>
      s
        .remove({ deleteVolumes: true })
        .pipe(Effect.map((status) => assert.strictEqual(status.state, "docker_unavailable"))),
    ),
  );

  it.effect("mints a credential only while running and keeps it out of errors", () =>
    Effect.gen(function* () {
      const stopped = yield* withSandbox({ container: "stopped" }, (s) =>
        s.pairingCredential.pipe(Effect.flip),
      );
      assert.strictEqual(stopped.reason, "invalid");
      const credential = yield* withSandbox({ container: "running" }, (s) => s.pairingCredential);
      assert.strictEqual(Redacted.value(credential), CREDENTIAL);
      assert.notInclude(String(credential), CREDENTIAL);
      const broken = yield* withSandbox({ container: "running", failing: "exec" }, (s) =>
        s.pairingCredential.pipe(Effect.flip),
      );
      assert.notInclude(broken.message, CREDENTIAL);
    }),
  );

  it("builds a Dockerfile that drops root and a stable image tag", () => {
    assert.include(AssistantSandbox.sandboxDockerfile, "USER node");
    assert.include(AssistantSandbox.sandboxDockerfile, "linkedEnvironmentsEnabled");
    const a = AssistantSandbox.sandboxImageTag("1", bundle);
    assert.strictEqual(a, AssistantSandbox.sandboxImageTag("1", bundle));
    assert.notStrictEqual(
      a,
      AssistantSandbox.sandboxImageTag("1", { ...bundle, dependencies: { zod: "5" } }),
    );
  });

  it.effect("resolves the bundle from a build with the installed runtime package versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const missing = yield* fs.makeTempDirectoryScoped();
      const refused = yield* AssistantSandbox.SandboxBundleSource.use(
        (source) => source.resolve,
      ).pipe(Effect.provide(AssistantSandbox.bundleSourceLayer(missing)), Effect.flip);
      assert.strictEqual(refused.reason, "bundle_missing");
      // The server package's own dist sits beside its node_modules.
      const dist = `${import.meta.dirname}/../../dist`;
      const found = yield* AssistantSandbox.SandboxBundleSource.use(
        (source) => source.resolve,
      ).pipe(Effect.provide(AssistantSandbox.bundleSourceLayer(dist)), Effect.option);
      if (found._tag === "Some") assert.match(found.value.dependencies.zod ?? "", /^\d+\./);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
