//! v1 IPC envelope and message types. This module is the Rust half of the contract in
//! `docs/arch/IPC.md`; the TypeScript bridge must match the same wire shapes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol major version. Only this value participates in wire-compatibility checks.
pub const PROTOCOL_VERSION: u32 = 1;

/// Envelope byte limit. A message larger than this is rejected before deserialization.
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Shared message envelope. `id` is present on requests/responses/errors and omitted on
/// events. `payload` stays untyped here so the host can dispatch on `msg_type` first.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub ts: u64,
    pub payload: Value,
}

impl Envelope {
    /// Build a response/error envelope that echoes the offending request `id` when known.
    pub fn new(msg_type: impl Into<String>, id: Option<String>, ts: u64, payload: Value) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            msg_type: msg_type.into(),
            ts,
            payload,
        }
    }
}

/// `request.hello` body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloRequest {
    pub nonce: String,
    pub adapter_version: String,
    pub session_id: String,
    pub capabilities: Vec<String>,
}

/// `response.hello` body. The engine reports its own full capability set; the effective
/// set is the intersection of adapter and engine capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    pub engine_version: String,
    pub nonce: String,
    pub capabilities: Vec<String>,
}

/// Wire error codes from `docs/arch/IPC.md` (Errors).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    Version,
    BadRequest,
    Protocol,
    TooLarge,
    Busy,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Version => "version",
            ErrorCode::BadRequest => "badRequest",
            ErrorCode::Protocol => "protocol",
            ErrorCode::TooLarge => "tooLarge",
            ErrorCode::Busy => "busy",
            ErrorCode::Internal => "internal",
        }
    }

    /// The `error.*` message type carrying this code.
    pub fn message_type(self) -> String {
        format!("error.{}", self.as_str())
    }
}

/// `error.*` body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

/// Raw adapter counts supplied with an observation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedCounts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_len: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_count: Option<u64>,
    /// A token count reported directly by a validated source (e.g. a diagnostic log
    /// usage line). When present, it is treated as `observed`, not estimated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_count: Option<u64>,
}

/// `request.ingestObservation` body. Read-only candidate evidence; never confirms
/// inclusion. `transientContent` may be `null` or omitted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestObservationRequest {
    pub session_id: String,
    pub source_identity: String,
    pub source_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<ObservedCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transient_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measurement: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<String>,
}

/// `response.ingestObservation` body. `tokenCount` is omitted when unknown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestObservationResponse {
    pub source_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_count: Option<u64>,
    pub measurement: String,
}

/// `request.recordRequestSnapshot` body. Inclusion is written only here; `confirmedSourceKeys`
/// and `candidateSourceKeys` are disjoint and must reference previously ingested sources.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRequestSnapshotRequest {
    pub session_id: String,
    pub request_id: String,
    pub sent_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usable_budget_tokens: Option<u64>,
    #[serde(default)]
    pub confirmed_source_keys: Vec<String>,
    #[serde(default)]
    pub candidate_source_keys: Vec<String>,
    #[serde(default)]
    pub unknown_source_count: u64,
    pub provenance: String,
}

/// `response.recordRequestSnapshot` body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRequestSnapshotResponse {
    pub request_id: String,
    pub recorded: bool,
    pub request_sent_seq: u64,
}

/// `request.getRecommendations` body. `requestId` is optional; when absent the engine
/// ranks current candidate pressure.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRecommendationsRequest {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// One frozen recommendation on the wire. Exactly one of `basisRequestId` or
/// `basisCandidateRevision` is present.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationItem {
    pub fix_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub basis_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub basis_candidate_revision: Option<u64>,
    pub policy_revision: u64,
    pub action_kind: String,
    pub title: String,
    pub source_kind: String,
    pub target_source_keys: Vec<String>,
    pub detail: String,
    pub estimated_tokens_saved_min: u64,
    pub estimated_tokens_saved_max: u64,
    pub measurement: String,
    pub reversible: bool,
    pub execution: String,
}

/// `response.recommendations` body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationsResponse {
    pub items: Vec<RecommendationItem>,
}

/// `request.reportLifecycle` body. Adapter-reported request markers and fix transitions.
/// Engine-owned kinds (`request_sent`, `fix_proposed`, `fix_verified`) are rejected here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportLifecycleRequest {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub kind: String,
    pub timestamp_ms: u64,
    #[serde(default)]
    pub removed_source_keys: Vec<String>,
}

/// `response.lifecycle` body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleResponse {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_state: Option<String>,
}

/// `request.setConfig` body. The adapter's authoritative policy copy; the engine stores it
/// and bumps `policyRevision` whenever the effective config changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigRequest {
    pub session_id: String,
    pub config: Value,
}

/// `response.setConfig` body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigResponse {
    pub policy_revision: u64,
    pub effective_config: Value,
}

/// `request.getTimeline` body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTimelineRequest {
    pub session_id: String,
    pub range_ms: u64,
    pub bucket_ms: u64,
}

/// One metric bucket in the timeline, aggregating candidate state over a time window.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricBucketView {
    pub window_start_ms: u64,
    pub bucket_ms: u64,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_latest_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_peak_tokens: Option<u64>,
    pub candidate_by_source_latest: std::collections::BTreeMap<String, u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_request_confirmed_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_request_id: Option<String>,
    pub request_count: usize,
    pub candidate_confidence_counts: std::collections::BTreeMap<String, u64>,
    pub lifecycle_marker_ids: Vec<u64>,
    pub fix_ids: Vec<String>,
}

/// `response.timeline` body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineResponse {
    pub cursor: u64,
    pub bucket_ms: u64,
    pub buckets: Vec<MetricBucketView>,
}

/// `request.subscribeMetrics` body. `afterSeq` is null to request a fresh snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeMetricsRequest {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_seq: Option<u64>,
}

/// `response.subscribeMetrics` body. Establishes the stream cursor atomically.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeMetricsResponse {
    pub cursor: u64,
    pub mode: String, // "replay" | "snapshot"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_from_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline: Option<TimelineResponse>,
}

/// `event.metrics` body. Pushed when candidate state changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsEvent {
    pub seq: u64,
    pub session_id: String,
    pub bucket: MetricBucketView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_pressure: Option<Value>, // CandidatePressureView
}

/// `event.streamGap` body. Subscriber fell behind; must re-fetch timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamGapEvent {
    pub session_id: String,
    pub last_delivered_seq: u64,
    pub earliest_available_seq: u64,
    pub current_seq: u64,
}

/// A rejection carrying the code and a human-readable, payload-free message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub code: ErrorCode,
    pub message: String,
}

impl Rejection {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// The engine's own capability set advertised in `response.hello`.
pub fn engine_capabilities() -> Vec<String> {
    [
        "signals.editor",
        "signals.terminalShellExecution",
        "signals.tools",
        "signals.participant",
        "tokenizer.registry",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

/// Effective capabilities are the intersection of adapter and engine sets, preserving the
/// engine's ordering.
pub fn intersect_capabilities(adapter: &[String], engine: &[String]) -> Vec<String> {
    engine
        .iter()
        .filter(|cap| adapter.contains(cap))
        .cloned()
        .collect()
}

/// Validate the first message and produce the `response.hello` body. No other request is
/// accepted before the handshake completes.
pub fn accept_hello(envelope: &Envelope, engine_version: &str) -> Result<HelloResponse, Rejection> {
    if envelope.v != PROTOCOL_VERSION {
        return Err(Rejection::new(
            ErrorCode::Version,
            format!("unsupported protocol version {}", envelope.v),
        ));
    }
    if envelope.msg_type != "request.hello" {
        return Err(Rejection::new(
            ErrorCode::Protocol,
            "handshake required before any other request",
        ));
    }
    let hello: HelloRequest = serde_json::from_value(envelope.payload.clone()).map_err(|err| {
        Rejection::new(
            ErrorCode::BadRequest,
            format!("invalid hello payload: {err}"),
        )
    })?;

    Ok(HelloResponse {
        engine_version: engine_version.to_owned(),
        nonce: hello.nonce,
        capabilities: engine_capabilities(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hello_envelope(v: u32) -> Envelope {
        Envelope {
            v,
            id: Some("01H".into()),
            msg_type: "request.hello".into(),
            ts: 1_757_001_600_000,
            payload: json!({
                "nonce": "nonce-123",
                "adapterVersion": "0.1.0",
                "sessionId": "01SESSION",
                "capabilities": ["signals.editor", "signals.participant"]
            }),
        }
    }

    #[test]
    fn envelope_round_trips_with_omitted_event_id() {
        let event = Envelope::new("event.streamGap", None, 1, json!({}));
        let line = serde_json::to_string(&event).unwrap();
        assert!(!line.contains("\"id\""));
        let parsed: Envelope = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed.msg_type, "event.streamGap");
        assert_eq!(parsed.id, None);
    }

    #[test]
    fn accept_hello_echoes_nonce_and_reports_engine_caps() {
        let response = accept_hello(&hello_envelope(1), "0.1.0").unwrap();
        assert_eq!(response.nonce, "nonce-123");
        assert_eq!(response.engine_version, "0.1.0");
        assert!(
            response
                .capabilities
                .contains(&"tokenizer.registry".to_owned())
        );
    }

    #[test]
    fn accept_hello_rejects_wrong_version() {
        let err = accept_hello(&hello_envelope(2), "0.1.0").unwrap_err();
        assert_eq!(err.code, ErrorCode::Version);
    }

    #[test]
    fn accept_hello_rejects_non_hello_first_message() {
        let mut envelope = hello_envelope(1);
        envelope.msg_type = "request.getTimeline".into();
        let err = accept_hello(&envelope, "0.1.0").unwrap_err();
        assert_eq!(err.code, ErrorCode::Protocol);
    }

    #[test]
    fn accept_hello_rejects_malformed_payload() {
        let mut envelope = hello_envelope(1);
        envelope.payload = json!({ "nonce": "only-nonce" });
        let err = accept_hello(&envelope, "0.1.0").unwrap_err();
        assert_eq!(err.code, ErrorCode::BadRequest);
    }

    #[test]
    fn intersection_preserves_engine_order_and_drops_unshared() {
        let adapter = vec![
            "signals.participant".to_owned(),
            "signals.editor".to_owned(),
            "diagnostics.copilotTrace".to_owned(),
        ];
        let effective = intersect_capabilities(&adapter, &engine_capabilities());
        assert_eq!(
            effective,
            vec![
                "signals.editor".to_owned(),
                "signals.participant".to_owned()
            ]
        );
    }

    #[test]
    fn error_code_maps_to_wire_message_type() {
        assert_eq!(ErrorCode::BadRequest.message_type(), "error.badRequest");
    }
}
