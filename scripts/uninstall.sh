#!/bin/bash
# Removes the app and the `vela` command. Spaces, worktrees and settings are kept.
set -euo pipefail
source "$(dirname "$0")/common.sh"
uninstall_app
rm -f "$BIN_DIR/vela"
echo "Vela uninstalled. Kept: ${VELA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/vela} (spaces, worktrees) and ${XDG_CONFIG_HOME:-$HOME/.config}/vela (settings)."
