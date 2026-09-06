//! contextTop engine stdio host.
//!
//! Reads newline-delimited JSON from `stdin`, writes responses/events to `stdout`, and
//! reserves `stderr` for diagnostics. This first increment implements the `request.hello`
//! handshake and graceful shutdown; observation, timeline, and recommendation dispatch
//! arrive in later increments. See `docs/IPC.md`.

use std::collections::BTreeMap;
use std::io::{self, BufReader, Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use contexttop_core::model::{
    CandidateStore, Coverage, Measurement, Provenance, RecordRequestInput, RequestSnapshot,
    SourceKind, SourceMeasurement, build_request_snapshot,
};
use contexttop_core::protocol::{
    Envelope, ErrorCode, ErrorPayload, GetRecommendationsRequest, GetTimelineRequest,
    IngestObservationRequest, IngestObservationResponse, MAX_MESSAGE_BYTES, MetricBucketView,
    PROTOCOL_VERSION, RecommendationItem, RecommendationsResponse, RecordRequestSnapshotRequest,
    RecordRequestSnapshotResponse, Rejection, SetConfigRequest, SetConfigResponse,
    SubscribeMetricsRequest, SubscribeMetricsResponse, TimelineResponse, accept_hello,
};
use contexttop_core::recommend::{RankInput, rank};
use contexttop_core::redaction::Redactor;
use contexttop_core::source_key::SessionKey;
use contexttop_core::tokenizer::{FALLBACK_ID, TokenizerRegistry};
use serde_json::{Value, json};
use ulid::Ulid;

const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Minimum known tokens for a source kind before a fix is proposed.
const MIN_FIX_TOKENS: u64 = 1_000;
/// How long (ms) to retain candidate measurements before tombstoning them.
const CANDIDATE_TTL_MS: u64 = 60 * 60 * 1000; // 1 hour

/// Per-session engine state established after the handshake.
struct EngineState {
    session_id: String,
    key: SessionKey,
    candidates: CandidateStore,
    tokenizer: TokenizerRegistry,
    redactor: Redactor,
    snapshots: BTreeMap<String, RequestSnapshot>,
    fix_ids: BTreeMap<String, String>,
    policy_revision: u64,
    effective_config: Value,
    next_seq: u64,
    event_seq: u64,
    subscription_cursor: Option<u64>,
}

impl EngineState {
    fn new(session_id: String) -> Self {
        Self::with_key(session_id, SessionKey::random())
    }

    fn with_key(session_id: String, key: SessionKey) -> Self {
        Self {
            session_id,
            key,
            candidates: CandidateStore::new(),
            tokenizer: TokenizerRegistry::new(),
            redactor: Redactor::default(),
            snapshots: BTreeMap::new(),
            fix_ids: BTreeMap::new(),
            policy_revision: 1,
            effective_config: Value::Null,
            next_seq: 1,
            event_seq: 1,
            subscription_cursor: None,
        }
    }

    /// Store the adapter's authoritative policy copy. Bumps `policy_revision` only when the
    /// effective config actually changes, so recommendation identity stays stable otherwise.
    fn set_config(&mut self, req: &SetConfigRequest) -> SetConfigResponse {
        if req.config != self.effective_config {
            self.effective_config = req.config.clone();
            self.policy_revision += 1;
        }
        SetConfigResponse {
            policy_revision: self.policy_revision,
            effective_config: self.effective_config.clone(),
        }
    }

    /// Derive a `sourceKey`, tokenize/estimate, and update the candidate gauge. Returns the
    /// wire response. Never confirms inclusion.
    fn ingest(
        &mut self,
        kind: SourceKind,
        req: &IngestObservationRequest,
        ts: u64,
    ) -> IngestObservationResponse {
        let source_key = self.key.derive(&req.source_identity);
        let (token_count, measurement, tokenizer_id) = self.derive_tokens(req);
        let byte_count = req.observed.as_ref().and_then(|o| o.byte_len);
        let coverage = req
            .coverage
            .as_deref()
            .and_then(Coverage::from_wire)
            .unwrap_or(Coverage::Unknown);
        let provenance = req
            .provenance
            .as_deref()
            .and_then(Provenance::from_wire)
            .unwrap_or(Provenance::DirectApi);

        // Observed request measurements (reported by a model provider or diagnostic
        // log) should not be treated as ambient candidate sources that inflate the
        // candidate gauge. Only record such measurements for metrics/visibility by
        // returning them; do not add them into `candidates`.
        if kind != SourceKind::ObservedRequest {
            self.candidates.observe(SourceMeasurement {
                source_key: source_key.clone(),
                source_kind: kind,
                token_count,
                tokenizer_id: tokenizer_id.clone(),
                byte_count,
                measurement,
                coverage,
                provenance,
                observed_at_ms: ts,
            });
            // Tombstone stale candidate sources on each ingest to keep the gauge bounded.
            // Use the incoming message timestamp `ts` (adapter-provided) as the basis
            // for TTL computation so tests that drive the engine with synthetic
            // timestamps behave deterministically.
            let cutoff = ts.saturating_sub(CANDIDATE_TTL_MS);
            self.candidates.purge_older_than(cutoff);
        }

        IngestObservationResponse {
            source_key,
            token_count,
            measurement: measurement.as_wire().to_owned(),
        }
    }

    /// Derive the token count and its measurement label. A directly-reported token count
    /// is `observed`; content or a byte count yields an `estimated` count via the fallback
    /// tokenizer; no basis yields `unknown`.
    fn derive_tokens(
        &self,
        req: &IngestObservationRequest,
    ) -> (Option<u64>, Measurement, Option<String>) {
        // A validated source (e.g. diagnostic usage line) may report tokens directly.
        if let Some(token_count) = req.observed.as_ref().and_then(|o| o.token_count) {
            return (Some(token_count), Measurement::Observed, None);
        }
        let tokenizer = self.tokenizer.for_model(None);
        if let Some(content) = req.transient_content.as_deref().filter(|c| !c.is_empty()) {
            // Redact before tokenizing so no secret/path could reach any later detail tier.
            let redacted = self.redactor.redact(content);
            return (
                Some(tokenizer.count_text(&redacted)),
                Measurement::Estimated,
                Some(FALLBACK_ID.to_owned()),
            );
        }
        if let Some(byte_len) = req.observed.as_ref().and_then(|o| o.byte_len) {
            return (
                Some(tokenizer.count_bytes(byte_len)),
                Measurement::Estimated,
                Some(FALLBACK_ID.to_owned()),
            );
        }
        (None, Measurement::Unknown, None)
    }

    /// Record an immutable request snapshot. A duplicate `requestId` is a protocol error;
    /// snapshots are never mutated after creation.
    fn record_snapshot(
        &mut self,
        req: &RecordRequestSnapshotRequest,
    ) -> Result<RecordRequestSnapshotResponse, Rejection> {
        if self.snapshots.contains_key(&req.request_id) {
            return Err(Rejection::new(
                ErrorCode::Protocol,
                format!("request snapshot '{}' already recorded", req.request_id),
            ));
        }
        let provenance = Provenance::from_wire(&req.provenance).ok_or_else(|| {
            Rejection::new(
                ErrorCode::BadRequest,
                format!("unknown provenance '{}'", req.provenance),
            )
        })?;

        let seq = self.next_seq;
        let input = RecordRequestInput {
            request_id: req.request_id.clone(),
            sent_at_ms: req.sent_at_ms,
            model_id: req.model_id.clone(),
            usable_budget_tokens: req.usable_budget_tokens,
            confirmed_source_keys: &req.confirmed_source_keys,
            candidate_source_keys: &req.candidate_source_keys,
            unknown_source_count: req.unknown_source_count,
            provenance,
        };
        let snapshot = build_request_snapshot(&self.candidates, input, seq)
            .map_err(|err| Rejection::new(ErrorCode::BadRequest, err.message()))?;

        self.next_seq += 1;
        self.snapshots.insert(req.request_id.clone(), snapshot);
        Ok(RecordRequestSnapshotResponse {
            request_id: req.request_id.clone(),
            recorded: true,
            request_sent_seq: seq,
        })
    }

    /// Rank current candidate pressure, or a recorded request snapshot when `requestId` is
    /// given. Ranking only; the engine never applies a fix. Proposal identity is memoized so
    /// repeated reads return the same `fixId`.
    fn get_recommendations(
        &mut self,
        req: &GetRecommendationsRequest,
    ) -> Result<RecommendationsResponse, Rejection> {
        let (inputs, basis_request_id, basis_candidate_revision, basis_key) = match &req.request_id
        {
            Some(request_id) => {
                let snapshot = self.snapshots.get(request_id).ok_or_else(|| {
                    Rejection::new(
                        ErrorCode::BadRequest,
                        format!("unknown requestId '{request_id}'"),
                    )
                })?;
                let inputs = snapshot
                    .confirmed
                    .iter()
                    .chain(snapshot.candidate.iter())
                    .map(|source| RankInput {
                        source_key: source.source_key.clone(),
                        source_kind: source.source_kind,
                        token_count: source.token_count,
                        measurement: source.measurement,
                    })
                    .collect::<Vec<_>>();
                (
                    inputs,
                    Some(request_id.clone()),
                    None,
                    format!("req:{request_id}"),
                )
            }
            None => {
                let revision = self.candidates.revision();
                let inputs = self
                    .candidates
                    .iter()
                    .map(|source| RankInput {
                        source_key: source.source_key.clone(),
                        source_kind: source.source_kind,
                        token_count: source.token_count,
                        measurement: source.measurement,
                    })
                    .collect::<Vec<_>>();
                (inputs, None, Some(revision), format!("rev:{revision}"))
            }
        };

        let items = rank(&inputs, MIN_FIX_TOKENS)
            .into_iter()
            .map(|rec| {
                let tuple = format!(
                    "{}|{}|{}|{}|{}|{}",
                    self.session_id,
                    basis_key,
                    self.policy_revision,
                    rec.action_kind.as_wire(),
                    rec.source_kind.as_wire(),
                    rec.target_source_keys.join(","),
                );
                let fix_id = self
                    .fix_ids
                    .entry(tuple)
                    .or_insert_with(|| Ulid::new().to_string())
                    .clone();
                RecommendationItem {
                    fix_id,
                    basis_request_id: basis_request_id.clone(),
                    basis_candidate_revision,
                    policy_revision: self.policy_revision,
                    action_kind: rec.action_kind.as_wire().to_owned(),
                    title: rec.title,
                    source_kind: rec.source_kind.as_wire().to_owned(),
                    target_source_keys: rec.target_source_keys,
                    detail: rec.detail,
                    estimated_tokens_saved_min: rec.estimated_tokens_saved_min,
                    estimated_tokens_saved_max: rec.estimated_tokens_saved_max,
                    measurement: rec.measurement.as_wire().to_owned(),
                    reversible: rec.reversible,
                    execution: rec.execution.as_wire().to_owned(),
                }
            })
            .collect();
        Ok(RecommendationsResponse { items })
    }

    /// Generate a timeline response for the given range. Buckets are derived from candidate
    /// state; request snapshots are included separately.
    fn get_timeline(&self, req: &GetTimelineRequest) -> Result<TimelineResponse, Rejection> {
        let now = now_ms();
        let _range_start = now.saturating_sub(req.range_ms);
        let mut buckets = Vec::new();

        // For now, emit one current bucket with the latest candidate state.
        // A real implementation would maintain a history of buckets per time window.
        let candidate_by_source =
            self.candidates
                .iter()
                .fold(BTreeMap::new(), |mut map, measurement| {
                    let kind_str = measurement.source_kind.as_wire().to_owned();
                    if let Some(tokens) = measurement.token_count {
                        *map.entry(kind_str).or_insert(0) += tokens;
                    }
                    map
                });

        let candidate_total: u64 = candidate_by_source.values().sum();

        let mut confidence_counts = BTreeMap::new();
        for measurement in self.candidates.iter() {
            let meas_str = measurement.measurement.as_wire().to_owned();
            *confidence_counts.entry(meas_str).or_insert(0) += 1;
        }

        let bucket = MetricBucketView {
            window_start_ms: now,
            bucket_ms: req.bucket_ms,
            session_id: self.session_id.clone(),
            candidate_latest_tokens: (candidate_total > 0).then_some(candidate_total),
            candidate_peak_tokens: (candidate_total > 0).then_some(candidate_total),
            candidate_by_source_latest: candidate_by_source,
            max_request_confirmed_tokens: self.snapshots.values().fold(None, |max, snap| {
                let confirmed = snap.confirmed_tokens();
                Some(max.map_or(confirmed.unwrap_or(0), |m: u64| {
                    m.max(confirmed.unwrap_or(0))
                }))
            }),
            max_request_id: self.snapshots.iter().next().map(|(id, _)| id.clone()),
            request_count: self.snapshots.len(),
            candidate_confidence_counts: confidence_counts,
            lifecycle_marker_ids: Vec::new(),
            fix_ids: Vec::new(),
        };

        buckets.push(bucket);

        Ok(TimelineResponse {
            cursor: self.event_seq,
            bucket_ms: req.bucket_ms,
            buckets,
        })
    }

    /// Subscribe to the metrics event stream. `afterSeq` resumes; `null` gives a fresh
    /// snapshot. Returns the correlated response; callers should emit live events afterward.
    fn subscribe_metrics(
        &mut self,
        _req: &SubscribeMetricsRequest,
    ) -> Result<SubscribeMetricsResponse, Rejection> {
        let cursor = self.event_seq;

        // For now, always use snapshot mode (simplified; v1 does not buffer events yet).
        let timeline = self.get_timeline(&GetTimelineRequest {
            session_id: self.session_id.clone(),
            range_ms: 900_000,
            bucket_ms: 5_000,
        })?;

        self.subscription_cursor = Some(cursor);

        Ok(SubscribeMetricsResponse {
            cursor,
            mode: "snapshot".to_owned(),
            replay_from_seq: None,
            timeline: Some(timeline),
        })
    }

    /// Generate a metrics event with the current candidate state.
    fn make_metrics_event(&self) -> Value {
        let now = now_ms();
        let candidate_by_source =
            self.candidates
                .iter()
                .fold(BTreeMap::new(), |mut map, measurement| {
                    let kind_str = measurement.source_kind.as_wire().to_owned();
                    if let Some(tokens) = measurement.token_count {
                        *map.entry(kind_str).or_insert(0) += tokens;
                    }
                    map
                });

        let candidate_total: u64 = candidate_by_source.values().sum();

        json!({
            "candidateLatestTokens": (candidate_total > 0).then_some(candidate_total),
            "candidatePeakTokens": (candidate_total > 0).then_some(candidate_total),
            "candidateBySourceLatest": candidate_by_source,
            "windowStartMs": now,
        })
    }
}

enum ReadOutcome {
    Message(Vec<u8>),
    TooLarge,
    Eof,
}

fn main() {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = stdout.lock();

    if let Err(err) = run(&mut reader, &mut writer) {
        eprintln!("contextTop engine: fatal I/O error: {err}");
        std::process::exit(1);
    }
}

fn run<R: Read, W: Write>(reader: &mut BufReader<R>, writer: &mut W) -> io::Result<()> {
    // Handshake: no other request is accepted before it completes.
    let mut state = match read_message(reader)? {
        ReadOutcome::Eof => return Ok(()),
        ReadOutcome::TooLarge => {
            send_error(
                writer,
                None,
                ErrorCode::TooLarge,
                "message exceeds 1 MiB envelope limit",
            )?;
            return Ok(());
        }
        ReadOutcome::Message(bytes) => match parse_envelope(&bytes) {
            Err(rejection) => {
                send_error(writer, None, rejection.code, rejection.message)?;
                return Ok(());
            }
            Ok(envelope) => match accept_hello(&envelope, ENGINE_VERSION) {
                Ok(response) => {
                    let session_id = envelope
                        .payload
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    send(
                        writer,
                        "response.hello",
                        envelope.id.clone(),
                        serde_json::to_value(&response).unwrap(),
                    )?;
                    EngineState::new(session_id)
                }
                Err(rejection) => {
                    send_error(
                        writer,
                        envelope.id.clone(),
                        rejection.code,
                        rejection.message,
                    )?;
                    return Ok(());
                }
            },
        },
    };

    // Post-handshake dispatch loop.
    loop {
        match read_message(reader)? {
            ReadOutcome::Eof => return Ok(()),
            ReadOutcome::TooLarge => {
                send_error(
                    writer,
                    None,
                    ErrorCode::TooLarge,
                    "message exceeds 1 MiB envelope limit",
                )?;
            }
            ReadOutcome::Message(bytes) => {
                let envelope = match parse_envelope(&bytes) {
                    Ok(envelope) => envelope,
                    Err(rejection) => {
                        send_error(writer, None, rejection.code, rejection.message)?;
                        continue;
                    }
                };
                if dispatch(writer, &envelope, &mut state)? {
                    return Ok(());
                }
            }
        }
    }
}

/// Returns `Ok(true)` when the host should shut down.
fn dispatch<W: Write>(
    writer: &mut W,
    envelope: &Envelope,
    state: &mut EngineState,
) -> io::Result<bool> {
    if envelope.v != PROTOCOL_VERSION {
        send_error(
            writer,
            envelope.id.clone(),
            ErrorCode::Version,
            format!("unsupported protocol version {}", envelope.v),
        )?;
        return Ok(false);
    }

    // Every post-hello message carrying `sessionId` must match the hello session.
    if let Some(incoming) = envelope.payload.get("sessionId").and_then(Value::as_str)
        && incoming != state.session_id
    {
        send_error(
            writer,
            envelope.id.clone(),
            ErrorCode::Protocol,
            "sessionId does not match hello session",
        )?;
        return Ok(false);
    }

    match envelope.msg_type.as_str() {
        "request.ingestObservation" => {
            match serde_json::from_value::<IngestObservationRequest>(envelope.payload.clone()) {
                Err(err) => send_error(
                    writer,
                    envelope.id.clone(),
                    ErrorCode::BadRequest,
                    format!("invalid ingestObservation payload: {err}"),
                )?,
                Ok(req) => match SourceKind::from_wire(&req.source_kind) {
                    None => send_error(
                        writer,
                        envelope.id.clone(),
                        ErrorCode::BadRequest,
                        format!("unknown sourceKind '{}'", req.source_kind),
                    )?,
                    Some(kind) => {
                        let response = state.ingest(kind, &req, envelope.ts);
                        send(
                            writer,
                            "response.ingestObservation",
                            envelope.id.clone(),
                            serde_json::to_value(response).unwrap(),
                        )?;

                        // Emit a metrics event after ingesting so the UI streams live.
                        state.event_seq += 1;
                        let metrics_event = state.make_metrics_event();
                        send(writer, "event.metrics", None, metrics_event)?;
                    }
                },
            }
            Ok(false)
        }
        "request.recordRequestSnapshot" => {
            match serde_json::from_value::<RecordRequestSnapshotRequest>(envelope.payload.clone()) {
                Err(err) => send_error(
                    writer,
                    envelope.id.clone(),
                    ErrorCode::BadRequest,
                    format!("invalid recordRequestSnapshot payload: {err}"),
                )?,
                Ok(req) => match state.record_snapshot(&req) {
                    Ok(response) => send(
                        writer,
                        "response.recordRequestSnapshot",
                        envelope.id.clone(),
                        serde_json::to_value(response).unwrap(),
                    )?,
                    Err(rejection) => send_error(
                        writer,
                        envelope.id.clone(),
                        rejection.code,
                        rejection.message,
                    )?,
                },
            }
            Ok(false)
        }
        "request.getRecommendations" => {
            match serde_json::from_value::<GetRecommendationsRequest>(envelope.payload.clone()) {
                Err(err) => send_error(
                    writer,
                    envelope.id.clone(),
                    ErrorCode::BadRequest,
                    format!("invalid getRecommendations payload: {err}"),
                )?,
                Ok(req) => match state.get_recommendations(&req) {
                    Ok(response) => send(
                        writer,
                        "response.recommendations",
                        envelope.id.clone(),
                        serde_json::to_value(response).unwrap(),
                    )?,
                    Err(rejection) => send_error(
                        writer,
                        envelope.id.clone(),
                        rejection.code,
                        rejection.message,
                    )?,
                },
            }
            Ok(false)
        }
        "request.getTimeline" => {
            match serde_json::from_value::<GetTimelineRequest>(envelope.payload.clone()) {
                Err(err) => send_error(
                    writer,
                    envelope.id.clone(),
                    ErrorCode::BadRequest,
                    format!("invalid getTimeline payload: {err}"),
                )?,
                Ok(req) => match state.get_timeline(&req) {
                    Ok(response) => send(
                        writer,
                        "response.timeline",
                        envelope.id.clone(),
                        serde_json::to_value(response).unwrap(),
                    )?,
                    Err(rejection) => send_error(
                        writer,
                        envelope.id.clone(),
                        rejection.code,
                        rejection.message,
                    )?,
                },
            }
            Ok(false)
        }
        "request.subscribeMetrics" => {
            match serde_json::from_value::<SubscribeMetricsRequest>(envelope.payload.clone()) {
                Err(err) => send_error(
                    writer,
                    envelope.id.clone(),
                    ErrorCode::BadRequest,
                    format!("invalid subscribeMetrics payload: {err}"),
                )?,
                Ok(req) => match state.subscribe_metrics(&req) {
                    Ok(response) => send(
                        writer,
                        "response.subscribeMetrics",
                        envelope.id.clone(),
                        serde_json::to_value(response).unwrap(),
                    )?,
                    Err(rejection) => send_error(
                        writer,
                        envelope.id.clone(),
                        rejection.code,
                        rejection.message,
                    )?,
                },
            }
            Ok(false)
        }
        "request.setConfig" => {
            match serde_json::from_value::<SetConfigRequest>(envelope.payload.clone()) {
                Err(err) => send_error(
                    writer,
                    envelope.id.clone(),
                    ErrorCode::BadRequest,
                    format!("invalid setConfig payload: {err}"),
                )?,
                Ok(req) => {
                    let response = state.set_config(&req);
                    send(
                        writer,
                        "response.setConfig",
                        envelope.id.clone(),
                        serde_json::to_value(response).unwrap(),
                    )?;
                }
            }
            Ok(false)
        }
        "request.shutdown" => {
            send(
                writer,
                "response.shutdown",
                envelope.id.clone(),
                json!({ "ok": true }),
            )?;
            Ok(true)
        }
        "request.hello" => {
            send_error(
                writer,
                envelope.id.clone(),
                ErrorCode::Protocol,
                "handshake already completed",
            )?;
            Ok(false)
        }
        other if other.starts_with("request.") => {
            send_error(
                writer,
                envelope.id.clone(),
                ErrorCode::BadRequest,
                format!("request '{other}' is not implemented in this engine build"),
            )?;
            Ok(false)
        }
        // Events and responses arriving at the engine are ignored per the envelope rules.
        _ => Ok(false),
    }
}

fn parse_envelope(bytes: &[u8]) -> Result<Envelope, Rejection> {
    serde_json::from_slice(bytes)
        .map_err(|err| Rejection::new(ErrorCode::BadRequest, format!("malformed message: {err}")))
}

fn send<W: Write>(
    writer: &mut W,
    msg_type: &str,
    id: Option<String>,
    payload: Value,
) -> io::Result<()> {
    let envelope = Envelope::new(msg_type, id, now_ms(), payload);
    let line = serde_json::to_string(&envelope).expect("envelope serializes");
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn send_error<W: Write>(
    writer: &mut W,
    id: Option<String>,
    code: ErrorCode,
    message: impl Into<String>,
) -> io::Result<()> {
    let payload = ErrorPayload {
        code: code.as_str().to_owned(),
        message: message.into(),
    };
    send(
        writer,
        &code.message_type(),
        id,
        serde_json::to_value(payload).unwrap(),
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_message<R: Read>(reader: &mut BufReader<R>) -> io::Result<ReadOutcome> {
    read_line_bounded(reader, MAX_MESSAGE_BYTES)
}

/// Reads one newline-delimited message, rejecting it before it grows past `max` bytes.
fn read_line_bounded<R: Read>(reader: &mut R, max: usize) -> io::Result<ReadOutcome> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = reader.read(&mut byte)?;
        if read == 0 {
            return Ok(if buf.is_empty() {
                ReadOutcome::Eof
            } else {
                ReadOutcome::Message(buf)
            });
        }
        if byte[0] == b'\n' {
            return Ok(ReadOutcome::Message(buf));
        }
        if buf.len() >= max {
            // Drain the remainder of the oversized line so the next read starts clean.
            loop {
                let read = reader.read(&mut byte)?;
                if read == 0 || byte[0] == b'\n' {
                    break;
                }
            }
            return Ok(ReadOutcome::TooLarge);
        }
        buf.push(byte[0]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn drive(input: &str) -> String {
        let mut reader = BufReader::new(Cursor::new(input.as_bytes().to_vec()));
        let mut out: Vec<u8> = Vec::new();
        run(&mut reader, &mut out).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn completes_handshake_then_shuts_down() {
        let hello = r#"{"v":1,"id":"01H","type":"request.hello","ts":1,"payload":{"nonce":"n","adapterVersion":"0.1.0","sessionId":"S1","capabilities":["signals.editor"]}}"#;
        let shutdown =
            r#"{"v":1,"id":"02H","type":"request.shutdown","ts":2,"payload":{"sessionId":"S1"}}"#;
        let out = drive(&format!("{hello}\n{shutdown}\n"));

        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"type\":\"response.hello\""));
        assert!(lines[0].contains("\"nonce\":\"n\""));
        assert!(lines[1].contains("\"type\":\"response.shutdown\""));
    }

    #[test]
    fn rejects_non_hello_first_message() {
        let out = drive(
            "{\"v\":1,\"id\":\"01H\",\"type\":\"request.getTimeline\",\"ts\":1,\"payload\":{}}\n",
        );
        assert!(out.contains("\"type\":\"error.protocol\""));
    }

    #[test]
    fn ingest_returns_source_key_and_estimated_tokens() {
        let hello = r#"{"v":1,"id":"01H","type":"request.hello","ts":1,"payload":{"nonce":"n","adapterVersion":"0.1.0","sessionId":"S1","capabilities":["signals.editor"]}}"#;
        let ingest = r#"{"v":1,"id":"02H","type":"request.ingestObservation","ts":2,"payload":{"sessionId":"S1","sourceIdentity":"file:///a.ts#selection","sourceKind":"selection","transientContent":"hello world","measurement":"observed","coverage":"partial","provenance":"direct_api"}}"#;
        let out = drive(&format!("{hello}\n{ingest}\n"));
        let reply = out.lines().nth(1).unwrap();
        assert!(reply.contains("\"type\":\"response.ingestObservation\""));
        assert!(reply.contains("\"tokenCount\":3"));
        assert!(reply.contains("\"measurement\":\"estimated\""));
        // sourceKey is a 64-char lowercase hex HMAC digest.
        let value: serde_json::Value = serde_json::from_str(reply).unwrap();
        let source_key = value["payload"]["sourceKey"].as_str().unwrap();
        assert_eq!(source_key.len(), 64);
    }

    #[test]
    fn ingest_with_no_basis_is_unknown_and_omits_token_count() {
        let hello = r#"{"v":1,"id":"01H","type":"request.hello","ts":1,"payload":{"nonce":"n","adapterVersion":"0.1.0","sessionId":"S1","capabilities":[]}}"#;
        let ingest = r#"{"v":1,"id":"02H","type":"request.ingestObservation","ts":2,"payload":{"sessionId":"S1","sourceIdentity":"x","sourceKind":"tools","measurement":"unknown"}}"#;
        let out = drive(&format!("{hello}\n{ingest}\n"));
        let reply = out.lines().nth(1).unwrap();
        assert!(reply.contains("\"measurement\":\"unknown\""));
        assert!(!reply.contains("tokenCount"));
    }

    #[test]
    fn ingest_rejects_unknown_source_kind() {
        let hello = r#"{"v":1,"id":"01H","type":"request.hello","ts":1,"payload":{"nonce":"n","adapterVersion":"0.1.0","sessionId":"S1","capabilities":[]}}"#;
        let ingest = r#"{"v":1,"id":"02H","type":"request.ingestObservation","ts":2,"payload":{"sessionId":"S1","sourceIdentity":"x","sourceKind":"bogus","measurement":"observed"}}"#;
        let out = drive(&format!("{hello}\n{ingest}\n"));
        assert!(
            out.lines()
                .nth(1)
                .unwrap()
                .contains("\"type\":\"error.badRequest\"")
        );
    }

    fn fixed_state() -> EngineState {
        EngineState::with_key("S1".into(), SessionKey::from_bytes([9u8; 32]))
    }

    #[test]
    fn set_config_bumps_policy_revision_only_on_change() {
        let mut state = fixed_state();
        assert_eq!(state.policy_revision, 1);
        let cfg = serde_json::json!({ "warningThreshold": 0.7, "captureLevel": "metadata" });
        let req: SetConfigRequest =
            serde_json::from_value(serde_json::json!({ "sessionId": "S1", "config": cfg }))
                .unwrap();
        let r1 = state.set_config(&req);
        assert_eq!(r1.policy_revision, 2, "first config change bumps revision");
        // Same config again → no bump.
        let r2 = state.set_config(&req);
        assert_eq!(
            r2.policy_revision, 2,
            "unchanged config keeps revision stable"
        );
        // Different config → bump.
        let cfg2 = serde_json::json!({ "warningThreshold": 0.9 });
        let req2: SetConfigRequest =
            serde_json::from_value(serde_json::json!({ "sessionId": "S1", "config": cfg2 }))
                .unwrap();
        let r3 = state.set_config(&req2);
        assert_eq!(r3.policy_revision, 3);
        assert_eq!(r3.effective_config, cfg2);
    }

    #[test]
    fn transient_content_is_redacted_before_tokenizing() {
        let state = fixed_state();
        let req = ingest_req(serde_json::json!({
            "sessionId": "S1", "sourceIdentity": "sel", "sourceKind": "selection",
            "transientContent": "Authorization: Bearer supersecrettoken12345"
        }));
        // derive_tokens must not panic and must produce an estimated count from redacted text.
        let (tokens, measurement, _) = state.derive_tokens(&req);
        assert!(tokens.is_some());
        assert_eq!(measurement, contexttop_core::model::Measurement::Estimated);
    }

    fn ingest_req(value: serde_json::Value) -> IngestObservationRequest {
        serde_json::from_value(value).unwrap()
    }

    fn snapshot_req(value: serde_json::Value) -> RecordRequestSnapshotRequest {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn records_snapshot_confirming_participant_ingested_source() {
        let mut state = fixed_state();
        let ingest = ingest_req(serde_json::json!({
            "sessionId": "S1", "sourceIdentity": "participant:prompt", "sourceKind": "prompt",
            "transientContent": "summarize this", "measurement": "observed", "coverage": "complete",
            "provenance": "participant"
        }));
        let key = state.ingest(SourceKind::Prompt, &ingest, 2).source_key;

        let req = snapshot_req(serde_json::json!({
            "sessionId": "S1", "requestId": "01REQ", "sentAtMs": 3, "modelId": "gpt-4o",
            "confirmedSourceKeys": [key], "candidateSourceKeys": [], "unknownSourceCount": 0,
            "provenance": "participant"
        }));
        let response = state.record_snapshot(&req).unwrap();
        assert!(response.recorded);
        assert_eq!(response.request_sent_seq, 1);
    }

    #[test]
    fn snapshot_rejects_confirming_ambient_direct_api_source() {
        let mut state = fixed_state();
        let ingest = ingest_req(serde_json::json!({
            "sessionId": "S1", "sourceIdentity": "file:///a.ts#selection", "sourceKind": "selection",
            "transientContent": "code", "measurement": "observed", "coverage": "partial",
            "provenance": "direct_api"
        }));
        let key = state.ingest(SourceKind::Selection, &ingest, 2).source_key;

        let req = snapshot_req(serde_json::json!({
            "sessionId": "S1", "requestId": "01REQ", "sentAtMs": 3, "modelId": "gpt-4o",
            "confirmedSourceKeys": [key], "candidateSourceKeys": [], "unknownSourceCount": 0,
            "provenance": "participant"
        }));
        let rejection = state.record_snapshot(&req).unwrap_err();
        assert_eq!(rejection.code, ErrorCode::BadRequest);
    }

    #[test]
    fn duplicate_request_snapshot_is_protocol_error() {
        let mut state = fixed_state();
        let req = snapshot_req(serde_json::json!({
            "sessionId": "S1", "requestId": "01REQ", "sentAtMs": 3, "modelId": "gpt-4o",
            "confirmedSourceKeys": [], "candidateSourceKeys": [], "unknownSourceCount": 0,
            "provenance": "participant"
        }));
        assert!(state.record_snapshot(&req).is_ok());
        assert_eq!(
            state.record_snapshot(&req).unwrap_err().code,
            ErrorCode::Protocol
        );
    }

    fn recommendations_req(value: serde_json::Value) -> GetRecommendationsRequest {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn recommends_over_candidate_pressure_with_stable_fix_ids() {
        let mut state = fixed_state();
        let ingest = ingest_req(serde_json::json!({
            "sessionId": "S1", "sourceIdentity": "term:build", "sourceKind": "terminal",
            "observed": { "byteLen": 20000 }, "measurement": "observed", "coverage": "partial",
            "provenance": "direct_api"
        }));
        state.ingest(SourceKind::Terminal, &ingest, 2);

        let req = recommendations_req(serde_json::json!({ "sessionId": "S1" }));
        let first = state.get_recommendations(&req).unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].action_kind, "summarize_terminal");
        assert!(first.items[0].basis_candidate_revision.is_some());
        assert!(first.items[0].basis_request_id.is_none());
        assert!(first.items[0].execution == "guided");

        // A repeat read at the same candidate revision returns the same fixId.
        let second = state.get_recommendations(&req).unwrap();
        assert_eq!(first.items[0].fix_id, second.items[0].fix_id);
    }

    #[test]
    fn recommendations_for_unknown_request_id_is_bad_request() {
        let mut state = fixed_state();
        let req = recommendations_req(
            serde_json::json!({ "sessionId": "S1", "requestId": "does-not-exist" }),
        );
        assert_eq!(
            state.get_recommendations(&req).unwrap_err().code,
            ErrorCode::BadRequest
        );
    }

    #[test]
    fn rejects_session_mismatch_after_hello() {
        let hello = r#"{"v":1,"id":"01H","type":"request.hello","ts":1,"payload":{"nonce":"n","adapterVersion":"0.1.0","sessionId":"S1","capabilities":[]}}"#;
        let other = r#"{"v":1,"id":"02H","type":"request.reportLifecycle","ts":2,"payload":{"sessionId":"S2"}}"#;
        let out = drive(&format!("{hello}\n{other}\n"));
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[1].contains("\"type\":\"error.protocol\""));
    }

    #[test]
    fn malformed_first_line_is_bad_request() {
        let out = drive("not json\n");
        assert!(out.contains("\"type\":\"error.badRequest\""));
    }

    #[test]
    fn oversized_line_is_too_large() {
        let mut reader = Cursor::new(vec![b'a'; 32]);
        matches!(
            read_line_bounded(&mut reader, 8).unwrap(),
            ReadOutcome::TooLarge
        );
    }

    #[test]
    fn get_timeline_returns_candidate_state() {
        let hello = r#"{"v":1,"id":"01H","type":"request.hello","ts":1,"payload":{"nonce":"n","adapterVersion":"0.1.0","sessionId":"S1","capabilities":["signals.editor"]}}"#;
        let ingest = r#"{"v":1,"id":"02H","type":"request.ingestObservation","ts":2,"payload":{"sessionId":"S1","sourceIdentity":"file://test.txt","sourceKind":"files","observed":{"byteLen":1000},"measurement":"observed","coverage":"complete"}}"#;
        let timeline = r#"{"v":1,"id":"03H","type":"request.getTimeline","ts":3,"payload":{"sessionId":"S1","rangeMs":900000,"bucketMs":5000}}"#;
        let out = drive(&format!("{hello}\n{ingest}\n{timeline}\n"));

        assert!(out.contains("\"type\":\"response.timeline\""));
        assert!(out.contains("\"bucketMs\":5000"));
        assert!(out.contains("\"files\""));
    }

    #[test]
    fn subscribe_metrics_returns_snapshot() {
        let hello = r#"{"v":1,"id":"01H","type":"request.hello","ts":1,"payload":{"nonce":"n","adapterVersion":"0.1.0","sessionId":"S1","capabilities":["signals.editor"]}}"#;
        let ingest = r#"{"v":1,"id":"02H","type":"request.ingestObservation","ts":2,"payload":{"sessionId":"S1","sourceIdentity":"terminal:session1","sourceKind":"terminal","observed":{"byteLen":5000},"measurement":"observed","coverage":"complete"}}"#;
        let subscribe = r#"{"v":1,"id":"03H","type":"request.subscribeMetrics","ts":3,"payload":{"sessionId":"S1","afterSeq":null}}"#;
        let out = drive(&format!("{hello}\n{ingest}\n{subscribe}\n"));

        assert!(out.contains("\"type\":\"response.subscribeMetrics\""));
        assert!(out.contains("\"mode\":\"snapshot\""));
        assert!(out.contains("\"timeline\""));
    }
}
