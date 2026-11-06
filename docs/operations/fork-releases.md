# Fork releases

A fork publishes its own desktop and mobile builds without touching upstream's release pipeline
(`release.yml`). Installed desktop apps pick the new version up as an update.

## Version scheme

`<upstream version>-fork.<n>`, for example `0.1.6-fork.1`. The number in front is the upstream
release the fork is based on; `fork.n` counts the fork's own releases. After merging upstream
v0.1.7 the next version is `0.1.7-fork.1`. Only stable upstream bases are supported.

The desktop updater always asks the fork's feed for the `latest` channel, and `-fork.N` does not
make it look for another one: electron-updater reads `latest-mac.yml` from the repository's latest
non-prerelease GitHub Release, so the release must not be flagged prerelease. It then compares
versions as semver (`0.1.6-fork.2` < `0.1.6-fork.3` < `0.1.7-fork.1`).

## Publish a version

1. Bump and commit (this edits the server, desktop, web and contracts `package.json` files and
   the mobile `fork` profile in `apps/mobile/eas.json`):

   ```sh
   vp run fork:version                 # 0.1.6-fork.1 -> 0.1.6-fork.2
   vp run fork:version --base 0.1.7    # after merging upstream v0.1.7 -> 0.1.7-fork.1
   git commit -am "chore(release): 0.1.6-fork.2" && git push
   ```

2. Desktop: run the `Fork release` workflow (`gh workflow run fork-release.yml -f publish=true`).
   With `publish=false` it only builds and attaches the files to the run. It refuses to run if the
   versions disagree or `v<version>` already exists, and it never runs on `pingdotgg/t3code`.
   The release notes list the `feat`, `fix`/`perf` and upstream `merge` commit subjects since the
   previous release, so those subjects are what users read.
3. Mobile: run `Mobile EAS fork release` (`gh workflow run mobile-eas-fork-release.yml -f platform=ios`).
   iOS accepts only numeric versions, so the app version is the upstream base (`0.1.6`) and EAS
   counts the build number.

## What an unsigned build does

macOS installs an update only into an app signed with a Developer ID certificate. Without the Apple
secrets the workflow still produces a DMG and warns. The app still checks the fork's releases, but
instead of downloading anything it shows the usual update button, and the button opens the release
page so you can download the new DMG and install it by hand. The build marks itself with a
`manual-update` resource file. Local `vp run fork:update` builds carry no feed, so they never announce releases.

macOS ties permission grants (Screen Recording, Accessibility, Full Disk Access) to the app's
signature. An ad hoc signature changes with every build, so each install asked for them again. With
`FORK_MAC_SIGNING_P12` and `FORK_MAC_SIGNING_PASSWORD` set, the workflow signs every unsigned build
with that one self-signed certificate (`scripts/sign-macos.ts`), and the grants carry over. Losing
the certificate is recoverable: a new one costs one more round of grants.

Without a Developer ID or that certificate the app is signed ad hoc as a whole bundle. Electron's own linker
signature alone stops matching once the bundle is assembled, and macOS then reports a downloaded
copy as "damaged" with no way to open it; a local build hides this because it carries no quarantine
flag. The workflow runs `scripts/verify-mac-desktop-artifact.sh` on the DMG and zip and publishes
nothing that fails. To check a release by hand, run the same script on the file downloaded from the
release page.

Opening an unsigned build the first time: macOS refuses it once, then System Settings → Privacy &
Security shows **Open Anyway** for it. Right-click → Open no longer skips that step on recent macOS.

## GitHub secrets

Add these under Settings → Secrets and variables → Actions. Without them the desktop build is
unsigned; the workflow does not need `APPLE_TEAM_ID` or a provisioning profile.

| Secret                      | Value                                                                             |
| --------------------------- | --------------------------------------------------------------------------------- |
| `CSC_LINK`                  | Base64 of the "Developer ID Application" certificate exported as .p12             |
| `CSC_KEY_PASSWORD`          | The password chosen when exporting the .p12                                       |
| `APPLE_API_KEY`             | The text of the App Store Connect API key (.p8 file)                              |
| `APPLE_API_KEY_ID`          | The key's ID                                                                      |
| `APPLE_API_ISSUER`          | The issuer ID shown above the API keys list                                       |
| `EXPO_FORK_TOKEN`           | Expo access token (mobile only)                                                   |
| `FORK_MAC_SIGNING_P12`      | Base64 of a self-signed code signing .p12, used when the Apple secrets are absent |
| `FORK_MAC_SIGNING_PASSWORD` | Its .p12 password                                                                 |

A code signing certificate for `FORK_MAC_SIGNING_P12` needs no Apple account:
`openssl req -x509 -newkey rsa:3072 -nodes -days 9125` with `extendedKeyUsage=critical,codeSigning`,
then `openssl pkcs12 -export -legacy`. Keep the .p12 somewhere safe: secrets cannot be read back.

Getting them from a paid Apple Developer account:

1. **Certificate.** In Xcode → Settings → Accounts → Manage Certificates, add "Developer ID
   Application" (or create one at developer.apple.com → Certificates, which needs a CSR from
   Keychain Access). In Keychain Access, export it with its private key as a .p12 and set a
   password. `base64 -i cert.p12 | pbcopy` gives `CSC_LINK`.
2. **API key.** At appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect
   API, generate a key with the Developer role. Download the .p8 once; `pbcopy < AuthKey_XXXX.p8`
   gives `APPLE_API_KEY`. The key ID is in the list and the issuer ID is above it.
3. **Expo token.** expo.dev → Account settings → Access tokens.

Never paste these into a chat or commit them. Add them with `gh secret set NAME` or the web UI.
