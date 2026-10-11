fn main() {
    // Native functions are reachable only through our Rust command layer.
    tauri_plugin::Builder::new(&[]).ios_path("ios").build();
}
