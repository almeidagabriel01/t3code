#!/usr/bin/env bash
# Fails unless every app inside the given DMGs and zips carries a valid signature for its whole
# bundle. An app that fails this opens as "damaged" once downloaded, with no way past it.
# With --notarized, Gatekeeper must also accept it as downloaded (Developer ID builds).
set -euo pipefail

notarized=false
if [[ "${1:-}" == "--notarized" ]]; then
  notarized=true
  shift
fi
[[ $# -ge 1 ]] || {
  echo "Usage: $0 [--notarized] <artifact.dmg|artifact.zip>..." >&2
  exit 2
}

work="$(mktemp -d)"
mounts=()
cleanup() {
  for mount in "${mounts[@]+"${mounts[@]}"}"; do hdiutil detach -quiet "$mount" || true; done
  rm -rf "$work"
}
trap cleanup EXIT

verify_app() {
  local app="$1" label="$2"
  if ! codesign --verify --deep --strict --verbose=2 "$app"; then
    echo "::error::$label: the app's signature is invalid; macOS would call the download damaged." >&2
    return 1
  fi
  if [[ "$notarized" == true ]] && ! spctl --assess --type execute --verbose=2 "$app"; then
    echo "::error::$label: Gatekeeper rejects the app." >&2
    return 1
  fi
  echo "$label: signature valid."
}

status=0
for artifact in "$@"; do
  name="$(basename "$artifact")"
  case "$artifact" in
    *.dmg)
      mount="$work/mount-${#mounts[@]}"
      hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$artifact"
      mounts+=("$mount")
      apps=("$mount"/*.app)
      ;;
    *.zip)
      dest="$work/zip-$name"
      mkdir -p "$dest"
      ditto -x -k "$artifact" "$dest"
      apps=("$dest"/*.app)
      ;;
    *)
      echo "Skipping $name: not a dmg or zip." >&2
      continue
      ;;
  esac
  if [[ ! -e "${apps[0]}" ]]; then
    echo "::error::$name contains no app." >&2
    status=1
    continue
  fi
  for app in "${apps[@]}"; do verify_app "$app" "$name" || status=1; done
done
exit "$status"
