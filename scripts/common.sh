# Paths and helpers shared by the scripts. Platform details live in
# scripts/platform/<linux|macos>.sh.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN_DIR="$HOME/.local/bin"

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *) echo "Unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Defines APP (what gets installed), check_system, build_app, install_app, launch_app and
# uninstall_app.
source "$ROOT/scripts/platform/$PLATFORM.sh"

# Rust, Node and pnpm, the versions of mise.toml. When one is missing and mise is installed,
# mise installs them for this repo.
check_toolchain() {
  if ! have cargo || ! have pnpm || ! have node; then
    if have mise; then
      say "Installing the toolchain of mise.toml (rust, node, pnpm) with mise…"
      mise trust -q "$ROOT/mise.toml" >/dev/null 2>&1 || true
      (cd "$ROOT" && mise install)
      eval "$(cd "$ROOT" && mise env -s bash)"
    fi
  fi
  have cargo || die "cargo not found. Install Rust from https://rustup.rs (or install mise: https://mise.jdx.dev)"
  have node || die "node not found. Install Node.js 20 or newer (or mise)"
  have pnpm || {
    if have corepack; then corepack enable pnpm 2>/dev/null || true; fi
    have pnpm || die "pnpm not found. Install it with \`npm install -g pnpm\` (or mise)"
  }
  have git || die "git not found"
}

build_ui() {
  say "Building the interface…"
  pnpm -C "$ROOT/ui" install --frozen-lockfile
  pnpm -C "$ROOT/ui" build
}

# The `vela` command line (spaces, diff, agents, notes) in ~/.local/bin.
install_cli() {
  say "Building the vela command line…"
  cargo build --release --locked -p vela-cli --manifest-path "$ROOT/Cargo.toml"
  mkdir -p "$BIN_DIR"
  install -m 755 "$ROOT/target/release/vela" "$BIN_DIR/vela"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "Add $BIN_DIR to your PATH to use the \`vela\` command." ;;
  esac
}

# Is the app running? (Updating it under a running process is refused.)
app_running() { pgrep -x vela-app >/dev/null 2>&1 || pgrep -f "Vela.app/Contents/MacOS" >/dev/null 2>&1; }
