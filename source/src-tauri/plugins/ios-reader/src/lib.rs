use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Runtime};
#[cfg(target_os = "ios")]
use tauri::Manager;
use serde::{Serialize, de::DeserializeOwned};
pub mod fault;
pub use fault::NativeConnectionFault;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_reader);

pub struct IosReader<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> IosReader<R> {
    pub fn call<T: DeserializeOwned, A: Serialize>(&self, command: &str, args: A) -> Result<T, NativeConnectionFault> {
        #[cfg(target_os = "ios")]
        {
            let value: serde_json::Value = self.0.run_mobile_plugin(command, args)
                .map_err(|_| NativeConnectionFault::bridge())?;
            fault::decode(value)
        }
        #[cfg(not(target_os = "ios"))]
        { let _ = (command, args); Err(NativeConnectionFault::bridge()) }
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ios-reader").setup(|app, api| {
        #[cfg(target_os = "ios")]
        app.manage(IosReader(api.register_ios_plugin(init_plugin_ios_reader)?));
        #[cfg(not(target_os = "ios"))]
        let _ = (app, api);
        Ok(())
    }).build()
}
