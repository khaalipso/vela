#!/bin/bash
# Starts the installed Vela.
set -euo pipefail
source "$(dirname "$0")/common.sh"
[ -e "$APP" ] || die "Vela is not installed: run \`make install\`"
launch_app "$@"
