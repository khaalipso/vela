// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vela_app::shellenv::import_login_path();
    vela_app::run();
}
