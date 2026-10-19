use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

/// Whitelisted metadata only. Provider text and native exceptions never cross this boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConnectionFault {
    pub code: String,
    pub stage: String,
    pub request_id: Option<String>,
    pub retryable: bool,
    pub http_status: Option<u16>,
    pub native_error_code: Option<i32>,
    pub native_error_domain: Option<String>,
}
impl NativeConnectionFault {
    pub fn bridge() -> Self { Self { code: "bridge_failure".into(), stage: "bridge".into(), request_id: None, retryable: true, http_status: None, native_error_code: None, native_error_domain: None } }
    pub fn message(&self) -> &'static str {
        match self.code.as_str() {
            "missing_cookies" => "Twitter has not finished signing in. Complete sign-in, then tap Continue.",
            "transport_initialization" => "The secure connection could not initialize. Retry the connection.",
            "transaction_bootstrap" => "Twitter's connection metadata could not be read. Retry or update the app.",
            "authentication_expired" => "Twitter rejected this session. Sign in again.",
            "provider_rejection" => "Twitter could not accept this request. Try again later.",
            "rate_limited" => "X is limiting requests. Wait before checking the connection again.",
            "account_challenge" => "Complete the account verification requested by X, then continue.",
            "timeout" => "Twitter took too long to respond. Try again.",
            "cancelled" => "The connection attempt was cancelled.",
            "background_paused" => "Sign-in is paused until the app returns to the foreground.",
            "session_storage" => "The session could not be saved securely. Your previous session is retained.",
            "network_failure" => "Twitter could not be reached. Check your connection and retry.",
            "unsupported_response" => "Twitter returned an unsupported response. Retry or update the app.",
            _ => "The native connection bridge is unavailable. Reopen the app and retry.",
        }
    }
    fn safe(mut self) -> Self {
        if !["missing_cookies","transport_initialization","transaction_bootstrap","authentication_expired","provider_rejection","rate_limited","account_challenge","timeout","cancelled","background_paused","session_storage","network_failure","unsupported_response","bridge_failure"].contains(&self.code.as_str()) { return Self::bridge(); }
        if !["login","cookies","transport","transport_navigation","transport_origin","transport_process","transport_script","bootstrap","identity","provider","storage","bridge","queue"].contains(&self.stage.as_str()) { self.stage = "bridge".into(); }
        self.request_id = self.request_id.filter(|id| !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit()));
        self.http_status = self.http_status.filter(|s| (100..=599).contains(s));
        self.native_error_domain = self.native_error_domain.filter(|d| ["url","webkit","other"].contains(&d.as_str()));
        self.native_error_code = self.native_error_code.filter(|c| (-100_000..=100_000).contains(c) && self.native_error_domain.is_some());
        self
    }
}
pub fn decode<T: DeserializeOwned>(value: Value) -> Result<T, NativeConnectionFault> {
    if let Some(fault) = value.get("fault") {
        return Err(serde_json::from_value::<NativeConnectionFault>(fault.clone()).map(|v| v.safe()).unwrap_or_else(|_| NativeConnectionFault::bridge()));
    }
    serde_json::from_value(value).map_err(|_| NativeConnectionFault { code: "unsupported_response".into(), stage: "bridge".into(), ..NativeConnectionFault::bridge() })
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rejects_native_payload_text_and_unknown_metadata() {
        let fault = decode::<Value>(serde_json::json!({"fault":{"code":"timeout","stage":"secret-cookie","requestId":"auth_token=secret","retryable":true,"httpStatus":999},"message":"ct0=secret"})).unwrap_err();
        let safe = serde_json::to_string(&fault).unwrap();
        assert!(!safe.contains("secret")); assert_eq!(fault.stage,"bridge"); assert_eq!(fault.http_status,None);
    }
    #[test] fn handles_success_and_bad_wire_shapes() {
        assert_eq!(decode::<Value>(serde_json::json!({"status":200})).unwrap()["status"],200);
        assert_eq!(decode::<Value>(serde_json::json!({"fault":{}})).unwrap_err().code,"bridge_failure");
        assert_eq!(decode::<u32>(serde_json::json!({})).unwrap_err().code,"unsupported_response");
    }
    #[test] fn preserves_only_fixed_native_error_metadata() {
        let fault = decode::<Value>(serde_json::json!({"fault":{"code":"transport_initialization","stage":"transport_navigation","requestId":"2","retryable":true,"httpStatus":null,"nativeErrorCode":-1022,"nativeErrorDomain":"url","description":"auth_token=secret"}})).unwrap_err();
        assert_eq!(fault.native_error_code,Some(-1022)); assert_eq!(fault.stage,"transport_navigation");
        assert!(!serde_json::to_string(&fault).unwrap().contains("secret"));
        let invalid = decode::<Value>(serde_json::json!({"fault":{"code":"transport_initialization","stage":"transport_script","retryable":true,"nativeErrorCode":9,"nativeErrorDomain":"auth_token=secret"}})).unwrap_err();
        assert!(invalid.native_error_domain.is_none() && invalid.native_error_code.is_none());
    }
}
