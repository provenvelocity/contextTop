use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Observed,
    Estimated,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Ord, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Prompt,
    Selection,
    Files,
    Terminal,
    History,
    Tools,
    ToolResults,
    Retrieval,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    SourceChanged,
    RequestStarted,
    RequestSent,
    ResponseStarted,
    ToolStarted,
    ToolFinished,
    RequestCompleted,
    FixProposed,
    FixApplied,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextEvent {
    pub timestamp_ms: u64,
    pub session_id: String,
    pub request_id: Option<String>,
    pub event_kind: EventKind,
    pub source_kind: Option<SourceKind>,
    pub token_count: Option<u64>,
    pub confidence: Confidence,
    pub source_fingerprint: Option<String>,
    pub metadata_redacted: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextBucket {
    pub window_start_ms: u64,
    pub session_id: String,
    pub token_total_estimated: u64,
    pub token_by_source_kind: std::collections::BTreeMap<SourceKind, u64>,
    pub confidence_summary: Confidence,
    pub request_ids: Vec<String>,
    pub fix_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FixKind {
    FocusTerminal,
    HandoffHistory,
    ExcludeGeneratedFiles,
    ReduceTools,
    DetachFiles,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FixScope {
    CurrentRequest,
    NewChat,
    WorkspaceSettings,
    CurrentAgentSession,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FixDisposition {
    Advisory,
    Supported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Recommendation {
    pub id: String,
    pub kind: FixKind,
    pub title: String,
    pub scope: FixScope,
    pub evidence: String,
    pub expected_savings: u64,
    pub reversible: bool,
    pub disposition: FixDisposition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FixAction {
    Preview,
    Apply,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FixResult {
    pub fix_id: String,
    pub action: FixAction,
    pub accepted: bool,
    pub advisory: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IpcEnvelope {
    pub protocol_version: u16,
    pub message_id: String,
    pub message: IpcMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum IpcMessage {
    Hello { handshake_token: String },
    Event(ContextEvent),
    FixAction { fix_id: String, action: FixAction },
    Bucket(ContextBucket),
    Recommendations(Vec<Recommendation>),
    FixResult(FixResult),
    Error { code: String, message: String },
}
