#!/bin/bash
# Builds Vela from this checkout and installs it for the current user (no root needed):
#   Linux  ~/.local/bin/vela-app and a desktop entry
#   macOS  ~/Applications/Vela.app
# plus the `vela` command line in ~/.local/bin. Spaces, worktrees and settings are kept
# across installs (~/.local/share/vela, ~/.config/vela).
set -euo pipefail
source "$(dirname "$0")/common.sh"

if app_running && [ "${VELA_FORCE:-}" != 1 ]; then
  die "Vela is running: quit it before installing (or set VELA_FORCE=1)"
fi
check_system
check_toolchain
build_app
install_app
install_cli
say "Vela installed: $APP"
echo "Start it from your app launcher$([ "$PLATFORM" = macos ] && echo ", Spotlight or Launchpad"), or run \`make launch\`."
