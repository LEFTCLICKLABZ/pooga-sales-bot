#!/bin/zsh
SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 78
export PATH="/Users/mitchgach/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec /Users/mitchgach/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node src/index.js
