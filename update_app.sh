#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -x ./install.sh ]]; then
  ADROP_REPO_URL="${ADROP_REPO_URL:-}" ./install.sh
else
  echo "install.sh not found." >&2
  exit 1
fi

