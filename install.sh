#!/usr/bin/env bash
set -euo pipefail

APP_NAME="aDrop"
REPO_URL="${ADROP_REPO_URL:-https://github.com/AbrarAltaay/aDrop.git}"
INSTALL_ROOT="${ADROP_INSTALL_ROOT:-$HOME/.adrop}"
SOURCE_DIR="$INSTALL_ROOT/source"
APP_DEST="${ADROP_APP_DEST:-/Applications/$APP_NAME.app}"

say() {
  printf "\n%s\n" "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf "Missing required command: %s\n" "$1" >&2
    return 1
  fi
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "aDrop installer currently supports macOS only." >&2
  exit 1
fi

require_command git || exit 1
require_command codesign || exit 1
require_command node || {
  echo "Install Node.js first from https://nodejs.org, then run this installer again." >&2
  exit 1
}
require_command npm || exit 1

say "Installing $APP_NAME from source..."
mkdir -p "$INSTALL_ROOT"

if [[ -d "$SOURCE_DIR/.git" ]]; then
  say "Updating existing source checkout..."
  git -C "$SOURCE_DIR" fetch --depth 1 origin
  git -C "$SOURCE_DIR" reset --hard origin/HEAD
else
  rm -rf "$SOURCE_DIR"
  git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"
fi

cd "$SOURCE_DIR"

say "Installing dependencies..."
npm ci

say "Building $APP_NAME.app..."
npm run pack:mac

BUILT_APP="$(find "$SOURCE_DIR/release" -maxdepth 3 -type d -name "$APP_NAME.app" | head -n 1)"
if [[ -z "$BUILT_APP" ]]; then
  echo "Could not find built $APP_NAME.app under $SOURCE_DIR/release" >&2
  exit 1
fi

say "Applying free local ad-hoc signature..."
codesign --force --deep --sign - "$BUILT_APP"

say "Installing to $APP_DEST..."
if [[ "$APP_DEST" != "/Applications/$APP_NAME.app" && "$APP_DEST" != "$HOME/Applications/$APP_NAME.app" ]]; then
  echo "Refusing unexpected app destination: $APP_DEST" >&2
  exit 1
fi

install_app() {
  rm -rf "$APP_DEST"
  ditto "$BUILT_APP" "$APP_DEST"
}

if [[ -w "$(dirname "$APP_DEST")" ]]; then
  install_app
else
  sudo rm -rf "$APP_DEST"
  sudo ditto "$BUILT_APP" "$APP_DEST"
fi

say "$APP_NAME installed."
echo "Open it with:"
echo "  open \"$APP_DEST\""

if [[ "$APP_DEST" == /Applications/* ]]; then
  say "Note: this free build is unsigned/not notarized. If macOS blocks the first launch, right-click $APP_NAME in Applications and choose Open."
fi
