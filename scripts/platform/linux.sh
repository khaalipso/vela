# Linux: the binary goes to ~/.local/bin/vela-app, a .desktop entry and icons register the app.
APP="$BIN_DIR/vela-app"
DESKTOP="$HOME/.local/share/applications/vela.desktop"
ICONS="$HOME/.local/share/icons/hicolor"

check_system() {
  have pkg-config || die "pkg-config not found (see the Linux packages below)"
  if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    cat >&2 <<'MSG'
error: WebKitGTK 4.1 development files are missing. Install them, then run `make install` again:
  Arch:          sudo pacman -S --needed webkit2gtk-4.1 base-devel openssl librsvg
  Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev librsvg2-dev libayatana-appindicator3-dev
  Fedora:        sudo dnf install webkit2gtk4.1-devel openssl-devel librsvg2-devel && sudo dnf group install c-development
MSG
    exit 1
  fi
}

build_app() {
  build_ui
  say "Building the app (release)…"
  cargo build --release --locked -p vela-app --features custom-protocol --manifest-path "$ROOT/Cargo.toml"
}

install_app() {
  mkdir -p "$BIN_DIR" "$(dirname "$DESKTOP")"
  install -m 755 "$ROOT/target/release/vela-app" "$APP"
  for s in 32x32 128x128; do
    mkdir -p "$ICONS/$s/apps"
    cp "$ROOT/app/icons/$s.png" "$ICONS/$s/apps/vela.png"
  done
  mkdir -p "$ICONS/256x256/apps" "$ICONS/512x512/apps"
  cp "$ROOT/app/icons/128x128@2x.png" "$ICONS/256x256/apps/vela.png"
  cp "$ROOT/app/icons/icon.png" "$ICONS/512x512/apps/vela.png"
  mkdir -p "$ICONS/scalable/apps"
  cp "$ROOT/assets/icon.svg" "$ICONS/scalable/apps/vela.svg"
  cat > "$DESKTOP" <<DESK
[Desktop Entry]
Name=Vela
GenericName=Code editor
Comment=An editor built around tasks, for people who code with agents
Exec=$APP
Icon=vela
Terminal=false
Type=Application
Categories=Development;IDE;
StartupWMClass=vela-app
DESK
  update-desktop-database "$(dirname "$DESKTOP")" 2>/dev/null || true
  gtk-update-icon-cache -q "$ICONS" 2>/dev/null || true
}

launch_app() { nohup "$APP" "$@" >/dev/null 2>&1 & }

uninstall_app() {
  rm -f "$APP" "$DESKTOP"
  for s in 32x32 128x128 256x256 512x512; do rm -f "$ICONS/$s/apps/vela.png"; done
  rm -f "$ICONS/scalable/apps/vela.svg"
  update-desktop-database "$(dirname "$DESKTOP")" 2>/dev/null || true
}
