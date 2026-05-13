#!/usr/bin/env bash
# Wrapper around install.js — exists so Mac/Linux users can `./install.sh`.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/install.js" "$@"
