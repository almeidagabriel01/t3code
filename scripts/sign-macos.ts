// @effect-diagnostics nodeBuiltinImport:off - electron-builder calls this hook as a plain async function.
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import * as NodeChildProcess from "node:child_process";

export default async function sign(options: SignOptions): Promise<void> {
  const fixedIdentity = process.env.T3CODE_MAC_FIXED_IDENTITY;
  if (options.identity === "-" && fixedIdentity) {
    // A build without a Developer ID still signs with one fixed certificate, so macOS keeps its
    // permission grants across versions. codesign directly: osx-sign only takes trusted identities.
    const keychain = process.env.T3CODE_MAC_FIXED_KEYCHAIN;
    NodeChildProcess.execFileSync(
      "codesign",
      [
        "--force",
        "--deep",
        "--sign",
        fixedIdentity,
        ...(keychain ? ["--keychain", keychain] : []),
        options.app,
      ],
      { stdio: "inherit" },
    );
    return;
  }
  await signApplication({ ...options, batchCodesignCalls: true });
}
