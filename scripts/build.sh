#!/usr/bin/env bash
# Build Vela for daily use, on your real repos.
#   scripts/build.sh            build target/release/vela-app
#   scripts/build.sh --install  also install it as `vela-app` in ~/.local/bin with a desktop entry
# Repos are found under VELA_REPO_ROOTS (default ~/Work), and any folder can be added
# from the new space sheet. Spaces and worktrees live in ~/.local/share/vela.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -d ui/node_modules ] || pnpm -C ui install
pnpm -C ui build
cargo build --release -p vela-app --features custom-protocol
BIN="$ROOT/target/release/vela-app"
echo "Built $BIN"

if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/128x128/apps"
  install -m 755 "$BIN" "$HOME/.local/bin/vela-app"
  cp app/icons/128x128.png "$HOME/.local/share/icons/hicolor/128x128/apps/vela.png" 2>/dev/null || true
  cat > "$HOME/.local/share/applications/vela.desktop" <<EOF
[Desktop Entry]
Name=Vela
Comment=An editor built around tasks
Exec=$HOME/.local/bin/vela-app
Icon=vela
Type=Application
Categories=Development;IDE;
EOF
  echo "Installed ~/.local/bin/vela-app and the Vela desktop entry"
fi
