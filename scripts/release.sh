#!/usr/bin/env bash
# End-to-end production build + signed updater bundle for the host platform.
#
# Pipeline:
#   1. PyInstaller-bundle the Python sidecar into one binary.
#   2. Stage it in src-tauri/binaries/ where Tauri's `resources` expects it.
#   3. Run `tauri build` with a per-target override config + signing key.
#   4. Generate `latest.json` next to the bundle so a GitHub release upload
#      can serve it directly to the in-app updater.
#
# Required env (only when actually publishing):
#   TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/subtitle-studio.key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...   (empty if you set no passphrase)
#
# Optional:
#   SKIP_SIDECAR=1  → reuse existing binary in src-tauri/binaries/
#
# After it finishes you'll see a printout listing exactly what to attach to
# the GitHub release.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
case "$TRIPLE" in
  *windows*) EXE_SUFFIX=".exe" ;;
  *)         EXE_SUFFIX="" ;;
esac
BIN_NAME="worker-${TRIPLE}${EXE_SUFFIX}"
BIN_PATH="src-tauri/binaries/${BIN_NAME}"
OVERRIDE="src-tauri/tauri.release.conf.json"

cd "$ROOT"

# --- 1. Sidecar binary ------------------------------------------------------
if [[ -x "$BIN_PATH" && "${SKIP_SIDECAR:-0}" == "1" ]]; then
  echo "→ Reusing existing sidecar binary at $BIN_PATH (SKIP_SIDECAR=1)"
else
  echo "→ Building Python sidecar (target: $TRIPLE)…"
  ( cd python-sidecar && uv run python build_binary.py )
fi

if [[ ! -x "$BIN_PATH" ]]; then
  echo "✗ expected built sidecar at $BIN_PATH — aborting" >&2
  exit 1
fi

# --- 2. Override config -----------------------------------------------------
echo "→ Writing release override → $OVERRIDE"
cat >"$OVERRIDE" <<EOF
{
  "\$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "resources": ["binaries/${BIN_NAME}"]
  }
}
EOF

# --- 3. Tauri build (with signing) -----------------------------------------
# Pick up the key. Priority: explicit env var → default location → fail.
DEFAULT_KEY="$HOME/.tauri/subtitle-studio.key"
KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$DEFAULT_KEY}"

if [[ ! -f "$KEY_PATH" ]]; then
  echo "✗ Private key not found." >&2
  echo "  Looked at: $KEY_PATH" >&2
  echo "  Either move your key there, or set TAURI_SIGNING_PRIVATE_KEY_PATH to its location." >&2
  echo "  (Generate a new pair: npx tauri signer generate -w ~/.tauri/subtitle-studio.key)" >&2
  exit 1
fi

# Tauri reads the literal key contents from TAURI_SIGNING_PRIVATE_KEY (not a
# path). Export it for the build, and propagate the password (empty by
# default — the in-place generated key uses no passphrase unless you set one).
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
echo "→ Signing with key: $KEY_PATH"

echo "→ Building Tauri app…"
npx tauri build --config "$ROOT/$OVERRIDE"

# --- 4. latest.json for the in-app updater ---------------------------------
APP_VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
BUNDLE_DIR="src-tauri/target/release/bundle"

# Updater bundle for macOS: <App>.app.tar.gz + .sig sitting next to the .dmg
MAC_TARBALL="$(ls "$BUNDLE_DIR/macos/"*.app.tar.gz 2>/dev/null | head -1 || true)"
MAC_SIG="$(ls "$BUNDLE_DIR/macos/"*.app.tar.gz.sig 2>/dev/null | head -1 || true)"
DMG="$(ls "$BUNDLE_DIR/dmg/"*.dmg 2>/dev/null | head -1 || true)"

GH_REPO="mitsuhaq/subtitle-studio"
RELEASE_TAG="v${APP_VERSION}"
RELEASE_URL_BASE="https://github.com/${GH_REPO}/releases/download/${RELEASE_TAG}"

if [[ -n "$MAC_SIG" ]]; then
  SIG_CONTENT="$(cat "$MAC_SIG")"
  # GitHub silently rewrites spaces in uploaded asset filenames to dots
  # ("Subtitle Studio.app.tar.gz" → "Subtitle.Studio.app.tar.gz"). The URL
  # in latest.json must match the *served* name, not the local one.
  TARBALL_BASE="$(basename "$MAC_TARBALL")"
  ASSET_NAME="${TARBALL_BASE// /.}"
  cat > latest.json <<EOF
{
  "version": "${APP_VERSION}",
  "notes": "См. изменения в релизе на GitHub.",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIG_CONTENT}",
      "url": "${RELEASE_URL_BASE}/${ASSET_NAME}"
    }
  }
}
EOF
  echo "→ Wrote latest.json for v${APP_VERSION} (asset: ${ASSET_NAME})"
else
  echo "⚠ no .app.tar.gz.sig found — latest.json NOT generated"
  echo "  (this only happens if you didn't set TAURI_SIGNING_PRIVATE_KEY_PATH)"
fi

echo
echo "✔ Done."
echo
echo "Bundles:"
[[ -n "$DMG" ]]         && echo "  • $DMG"
[[ -n "$MAC_TARBALL" ]] && echo "  • $MAC_TARBALL"
[[ -n "$MAC_SIG" ]]     && echo "  • $MAC_SIG"
[[ -f latest.json ]]    && echo "  • latest.json"

if [[ -f latest.json ]]; then
  echo
  echo "Publish to GitHub:"
  echo "  gh release create ${RELEASE_TAG} \\"
  [[ -n "$DMG" ]]         && echo "    \"$DMG\" \\"
  [[ -n "$MAC_TARBALL" ]] && echo "    \"$MAC_TARBALL\" \\"
  [[ -n "$MAC_SIG" ]]     && echo "    \"$MAC_SIG\" \\"
  echo "    latest.json"
fi
