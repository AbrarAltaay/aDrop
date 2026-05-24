#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

npm run pack:mac

APP_PATH="$(find release -maxdepth 3 -type d -name 'aDrop.app' | head -n 1)"
if [ -n "$APP_PATH" ]; then
  echo "Applying free local ad-hoc signature..."
  codesign --force --deep --sign - "$APP_PATH"
  echo "Built app: $APP_PATH"
fi
