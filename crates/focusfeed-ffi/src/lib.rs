//! Closed native application API. Content payloads use the versioned, shared
//! serde model schema; arbitrary command names and credentials are not accepted.
use focusfeed_core::{CoreEngine, CoreRequest};
use std::sync::Arc;

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum NativeError {
    #[error("{code}: {message}")]
    Operation { code: String, message: String },
}

impl From<focusfeed_core::CoreError> for NativeError {
    fn from(error: focusfeed_core::CoreError) -> Self {
        Self::Operation { code: error.code, message: error.message }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum NativeOperation {
    SetAccount, IngestFeed, IngestProfile, IngestFollowing, GetFeed,
    GetBookmarkSlice, GetProfile, GetFollowing, GetPost, MarkRead, SetHidden,
    GetLists, UpsertList, DeleteList, SetListMember, GetPreferences, SetPreferences,
    GetFilterPresets, SetFilterPresets, GetResumeState, SetResumeState,
    PrepareAction, BeginAction, FinishAction, RegisterMedia, MediaHealth, RestartMedia,
    CancelMedia, Diagnostics, Search, ClearSession, GetMediaUrl, ValidateMediaUrl,
    RecoverMedia, ParseIdentity, ParsePostContent, ParseReplies,
    GetReadIds, GetPinnedAccounts, PinAccount, GetMutedWords, SetMutedWord, GetGroupCandidates,
    GetGroupFeed, ProbeMedia,
}

impl NativeOperation {
    fn name(self) -> &'static str {
        match self {
            Self::SetAccount => "set_account", Self::IngestFeed => "ingest_feed",
            Self::IngestProfile => "ingest_profile", Self::IngestFollowing => "ingest_following",
            Self::GetFeed => "get_feed", Self::GetBookmarkSlice => "get_bookmark_slice",
            Self::GetProfile => "get_profile", Self::GetFollowing => "get_following",
            Self::GetPost => "get_post", Self::MarkRead => "mark_read",
            Self::SetHidden => "set_hidden", Self::GetLists => "get_lists",
            Self::UpsertList => "upsert_list", Self::DeleteList => "delete_list",
            Self::SetListMember => "set_list_member", Self::GetPreferences => "get_preferences",
            Self::SetPreferences => "set_preferences", Self::GetFilterPresets => "get_filter_presets",
            Self::SetFilterPresets => "set_filter_presets", Self::GetResumeState => "get_resume_state",
            Self::SetResumeState => "set_resume_state", Self::PrepareAction => "prepare_action",
            Self::BeginAction => "begin_action",
            Self::FinishAction => "finish_action", Self::RegisterMedia => "register_media",
            Self::MediaHealth => "media_health", Self::RestartMedia => "restart_media",
            Self::CancelMedia => "cancel_media", Self::Diagnostics => "diagnostics",
            Self::Search => "search", Self::ClearSession => "clear_session",
            Self::GetMediaUrl => "get_media_url", Self::ValidateMediaUrl => "validate_media_url",
            Self::RecoverMedia => "recover_media",
            Self::ParseIdentity => "parse_identity", Self::ParsePostContent => "parse_post_content",
            Self::ParseReplies => "parse_replies",
            Self::GetReadIds => "get_read_ids", Self::GetPinnedAccounts => "get_pinned_accounts",
            Self::PinAccount => "pin_account", Self::GetMutedWords => "get_muted_words",
            Self::SetMutedWord => "set_muted_word", Self::GetGroupCandidates => "get_group_candidates",
            Self::GetGroupFeed => "get_group_feed", Self::ProbeMedia => "probe_media",
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeRequest {
    pub request_id: String,
    pub account_generation: u64,
    pub source_revision: u64,
    pub deadline_millis: u64,
    pub priority: u8,
    pub operation: NativeOperation,
    /// A single operation's validated shared-model payload. Never script source.
    pub arguments_json: String,
}

#[derive(uniffi::Object)]
pub struct NativeCore { engine: Arc<CoreEngine> }

#[uniffi::export]
impl NativeCore {
    #[uniffi::constructor]
    pub fn new(data_directory: String) -> Result<Arc<Self>, NativeError> {
        Ok(Arc::new(Self { engine: Arc::new(CoreEngine::open(data_directory)?) }))
    }

    /// Call on the application repository's background executor. The Swift
    /// async adapter owns dispatch; no Swift main-thread callback occurs here.
    pub fn execute(&self, request: NativeRequest) -> Result<String, NativeError> {
        let operation = serde_json::from_value(serde_json::Value::String(request.operation.name().into()))
            .map_err(|_| NativeError::Operation { code: "unsupported_operation".into(), message: "This core operation is unavailable.".into() })?;
        self.engine.execute(CoreRequest {
            request_id: request.request_id, account_generation: request.account_generation,
            source_revision: request.source_revision, deadline_millis: request.deadline_millis,
            priority: request.priority, operation, arguments_json: request.arguments_json,
        }).map_err(Into::into)
    }

    pub fn cancel_request(&self, request_id: String) { self.engine.cancel_request(&request_id); }
    pub fn shutdown(&self) -> Result<(), NativeError> { self.engine.shutdown().map_err(Into::into) }
    pub fn interface_version(&self) -> u32 { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operation_names_are_closed_and_unique() {
        let values = [NativeOperation::GetFeed,NativeOperation::GetPreferences,
            NativeOperation::PrepareAction,NativeOperation::RestartMedia];
        let names: std::collections::HashSet<_> = values.into_iter().map(NativeOperation::name).collect();
        assert_eq!(names.len(),values.len());
        assert!(!names.contains("request"));
    }
}
