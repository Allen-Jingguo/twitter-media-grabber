#!/usr/bin/env bash
#
# One-shot installer for the Video Media Grabber extension.
#
# A Chrome/Chromium extension cannot be silently installed from the terminal
# (the browser requires the user to confirm), but this script does everything
# that *can* be automated:
#   1. makes sure the extension files are present (clones the repo if needed),
#   2. generates the icons,
#   3. launches your Chrome/Edge/Brave/Chromium with the extension already
#      loaded via --load-extension, in an isolated profile.
#
# Usage:
#   ./install.sh            # auto-detect a browser and launch with the ext
#   ./install.sh --print    # just print manual "Load unpacked" instructions
#
# Works on Linux and macOS (bash).
set -euo pipefail

REPO_URL="https://github.com/Allen-Jingguo/Hello-World.git"
BRANCH="claude/brave-euler-EeNza"
SUBDIR="twitter-media-grabber"

# ---- locate the extension directory ---------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/manifest.json" ]; then
  EXT_DIR="$SCRIPT_DIR"                       # run from inside the extension
else
  # Not inside the repo: clone it into a local folder next to this script.
  CLONE_DIR="${TMPDIR:-/tmp}/video-media-grabber"
  if [ ! -d "$CLONE_DIR/.git" ]; then
    echo "==> Cloning extension into $CLONE_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$CLONE_DIR"
  else
    echo "==> Updating existing clone in $CLONE_DIR"
    git -C "$CLONE_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$CLONE_DIR" checkout -q "$BRANCH"
    git -C "$CLONE_DIR" reset --hard -q "origin/$BRANCH"
  fi
  EXT_DIR="$CLONE_DIR/$SUBDIR"
fi

echo "==> Extension directory: $EXT_DIR"

# ---- generate icons (best effort) -----------------------------------------
if command -v node >/dev/null 2>&1 && [ -f "$EXT_DIR/tools/make-icons.js" ]; then
  echo "==> Generating icons"
  (cd "$EXT_DIR" && node tools/make-icons.js >/dev/null 2>&1) || true
fi

# ---- find a Chromium-family browser ---------------------------------------
find_browser() {
  local candidates=(
    "$CHROME_BIN"
    google-chrome google-chrome-stable chromium chromium-browser
    brave-browser microsoft-edge microsoft-edge-stable
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  )
  for c in "${candidates[@]}"; do
    [ -z "${c:-}" ] && continue
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

print_manual() {
  cat <<EOF

Manual install (any Chromium browser):
  1. Open  chrome://extensions  (or edge://extensions)
  2. Enable  Developer mode  (top-right)
  3. Click  Load unpacked
  4. Select this folder:
       $EXT_DIR

EOF
}

if [ "${1:-}" = "--print" ]; then
  print_manual
  exit 0
fi

BROWSER="$(find_browser || true)"
if [ -z "$BROWSER" ]; then
  echo "!! No Chrome/Chromium/Brave/Edge found on PATH." >&2
  print_manual
  exit 1
fi

PROFILE_DIR="${TMPDIR:-/tmp}/vmg-chrome-profile"
mkdir -p "$PROFILE_DIR"

echo "==> Launching: $BROWSER"
echo "    with extension loaded and an isolated profile ($PROFILE_DIR)"
echo "    (close this browser window to stop; your normal browser is untouched)"

exec "$BROWSER" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXT_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "about:blank"
