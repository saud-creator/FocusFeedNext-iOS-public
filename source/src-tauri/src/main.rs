// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = app_lib::portable::run_deferred_cleanup() {
        std::process::exit(exit_code);
    }
    app_lib::run();
}
