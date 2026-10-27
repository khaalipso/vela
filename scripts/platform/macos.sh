# macOS: ~/Applications/Vela.app, built by the Tauri bundler and signed ad hoc so it opens
# without a developer certificate.
APP="$HOME/Applications/Vela.app"

check_system() {
  xcode-select -p >/dev/null 2>&1 || die "the Xcode command line tools are missing: run \`xcode-select --install\`, then \`make install\` again"
}

build_app() {
  say "Installing the interface dependencies…"
  pnpm -C "$ROOT/ui" install --frozen-lockfile
  say "Building Vela.app (release)…"
  # The bundler builds the interface (beforeBuildCommand) and enables the custom-protocol feature.
  (cd "$ROOT/app" && "$ROOT/ui/node_modules/.bin/tauri" build --bundles app)
}

install_app() {
  local built="$ROOT/target/release/bundle/macos/Vela.app"
  [ -d "$built" ] || die "the build did not produce $built"
  mkdir -p "$(dirname "$APP")"
  rm -rf "$APP.new"
  ditto "$built" "$APP.new"
  rm -rf "$APP"
  mv "$APP.new" "$APP"
  # Not notarized: drop the quarantine flag and sign ad hoc so Gatekeeper lets it run.
  xattr -cr "$APP"
  codesign --force --deep --sign - "$APP" 2>/dev/null || true
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" || true
}

launch_app() { open "$APP" --args "$@"; }

uninstall_app() { rm -rf "$APP"; }
