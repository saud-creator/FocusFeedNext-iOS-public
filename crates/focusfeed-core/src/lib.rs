//! Native application core. No Tauri runtime or credential-bearing UI API.
//! Legacy adapters and the native shell share the same canonical storage,
//! parsing, filtering, bookmark ordering and security implementations.

extern crate self as tauri_plugin_ios_reader;

#[path = "../../../source/src-tauri/plugins/ios-reader/src/fault.rs"]
pub mod fault;
pub use fault::NativeConnectionFault;
#[path = "../../../source/src-tauri/src/models.rs"]
pub mod models;
#[path = "../../../source/src-tauri/src/database.rs"]
pub mod database;
#[path = "../../../source/src-tauri/src/durable.rs"]
pub mod durable;
#[path = "../../../source/src-tauri/src/preferences.rs"]
pub mod preferences;
#[path = "../../../source/src-tauri/src/security.rs"]
pub mod security;
#[path = "../../../source/src-tauri/src/media_proxy.rs"]
pub mod media_proxy;
#[path = "../../../source/src-tauri/src/providers/content.rs"]
pub mod content;
#[path = "../../../source/src-tauri/src/providers/native_parser.rs"]
pub mod provider_parser;
#[cfg(test)]
#[path = "test_providers.rs"]
pub mod providers;

mod engine;
mod metadata;
pub use engine::{CoreEngine, CoreError, CoreOperation, CoreRequest, FeedView};
pub use metadata::{FilterPreset, ResumeState};
