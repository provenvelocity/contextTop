//! Core domain model. Three independent axes — Measurement × Inclusion × Coverage — plus
//! the candidate pressure gauge. See `docs/METRICS.md`. `partial` is coverage only; it is
//! never a measurement.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Source categories carried on the wire (`docs/METRICS.md` source categories).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Prompt,
    /// Observed request measurements reported by a provider or diagnostic log. These are
    /// authoritative observed request totals and should not be treated as candidate
    /// ambient sources for the candidate gauge.
    ObservedRequest,
    Instructions,
    Selection,
    Files,
    Terminal,
    History,
    Tools,
    ToolResults,
    Retrieval,
    Unknown,
}

impl SourceKind {
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "prompt" => Self::Prompt,
            "observed_request" => Self::ObservedRequest,
            "instructions" => Self::Instructions,
            "selection" => Self::Selection,
            "files" => Self::Files,
            "terminal" => Self::Terminal,
            "history" => Self::History,
            "tools" => Self::Tools,
            "tool_results" => Self::ToolResults,
            "retrieval" => Self::Retrieval,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::ObservedRequest => "observed_request",
            Self::Instructions => "instructions",
            Self::Selection => "selection",
            Self::Files => "files",
            Self::Terminal => "terminal",
            Self::History => "history",
            Self::Tools => "tools",
            Self::ToolResults => "tool_results",
            Self::Retrieval => "retrieval",
            Self::Unknown => "unknown",
        }
    }
}

/// Measurement axis: confidence in a derived token count. Never `partial`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Measurement {
    Observed,
    Estimated,
    Unknown,
}

impl Measurement {
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "observed" => Self::Observed,
            "estimated" => Self::Estimated,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Observed => "observed",
            Self::Estimated => "estimated",
            Self::Unknown => "unknown",
        }
    }
}

/// Inclusion axis: whether a source is part of a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Inclusion {
    Confirmed,
    Candidate,
    Unknown,
}

/// Coverage axis: how completely the content behind a measurement was seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Coverage {
    Complete,
    Partial,
    Unknown,
}

impl Coverage {
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "complete" => Self::Complete,
            "partial" => Self::Partial,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }
}

/// Provenance of an observation. Ambient direct-API observations are candidate evidence;
/// participant/diagnostic provenance is required to confirm inclusion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    DirectApi,
    Participant,
    Diagnostic,
}

impl Provenance {
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "direct_api" => Self::DirectApi,
            "participant" => Self::Participant,
            "diagnostic" => Self::Diagnostic,
            _ => return None,
        })
    }
}

/// A single derived measurement for one source. Raw identity/content are never stored; the
/// engine keeps only the HMAC `source_key` and derived counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceMeasurement {
    pub source_key: String,
    pub source_kind: SourceKind,
    pub token_count: Option<u64>,
    pub tokenizer_id: Option<String>,
    pub byte_count: Option<u64>,
    pub measurement: Measurement,
    pub coverage: Coverage,
    pub provenance: Provenance,
    pub observed_at_ms: u64,
}

/// Candidate pressure is a **gauge**: an observation for a `source_key` replaces the prior
/// one. Repeated observations and multiple sources are never summed into a running total.
#[derive(Debug, Clone, Default)]
pub struct CandidateStore {
    by_source: BTreeMap<String, SourceMeasurement>,
    revision: u64,
}

impl CandidateStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the measurement for its `source_key`. The revision advances only when a
    /// ranked input actually changes (kind, token count, measurement, or coverage), so
    /// idempotent re-observations do not churn recommendation identity.
    pub fn observe(&mut self, measurement: SourceMeasurement) -> u64 {
        let changed = match self.by_source.get(&measurement.source_key) {
            Some(prev) => {
                prev.token_count != measurement.token_count
                    || prev.source_kind != measurement.source_kind
                    || prev.measurement != measurement.measurement
                    || prev.coverage != measurement.coverage
            }
            None => true,
        };
        self.by_source
            .insert(measurement.source_key.clone(), measurement);
        if changed {
            self.revision += 1;
        }
        self.revision
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn len(&self) -> usize {
        self.by_source.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_source.is_empty()
    }

    pub fn get(&self, source_key: &str) -> Option<&SourceMeasurement> {
        self.by_source.get(source_key)
    }

    /// Iterate the current measurement for every tracked source.
    pub fn iter(&self) -> impl Iterator<Item = &SourceMeasurement> {
        self.by_source.values()
    }

    /// Sum of the token counts we could measure. `None` when no source has a known count.
    pub fn total_known_tokens(&self) -> Option<u64> {
        let mut total = 0u64;
        let mut any = false;
        for measurement in self.by_source.values() {
            if let Some(tokens) = measurement.token_count {
                total = total.saturating_add(tokens);
                any = true;
            }
        }
        any.then_some(total)
    }

    /// Sources present in the gauge whose token count could not be measured.
    pub fn unknown_source_count(&self) -> usize {
        self.by_source
            .values()
            .filter(|m| m.token_count.is_none())
            .count()
    }

    /// Remove measurements older than `cutoff_ms`. Returns the new revision.
    pub fn purge_older_than(&mut self, cutoff_ms: u64) -> u64 {
        let keys: Vec<String> = self
            .by_source
            .iter()
            .filter(|(_, m)| m.observed_at_ms < cutoff_ms)
            .map(|(k, _)| k.clone())
            .collect();
        let mut changed = false;
        for k in keys {
            if self.by_source.remove(&k).is_some() {
                changed = true;
            }
        }
        if changed {
            self.revision += 1;
        }
        self.revision
    }
}

/// One source as captured in an immutable request snapshot, tagged with its inclusion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotSource {
    pub source_key: String,
    pub source_kind: SourceKind,
    pub token_count: Option<u64>,
    pub measurement: Measurement,
    pub coverage: Coverage,
    pub inclusion: Inclusion,
    pub provenance: Provenance,
}

/// An immutable record of one request's context composition. Confirmed tokens are the only
/// request total; candidate evidence stays separately labeled. Later lifecycle events
/// update a separate projection and never mutate this record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestSnapshot {
    pub request_id: String,
    pub sent_at_ms: u64,
    pub model_id: Option<String>,
    pub usable_budget_tokens: Option<u64>,
    pub confirmed: Vec<SnapshotSource>,
    pub candidate: Vec<SnapshotSource>,
    pub unknown_source_count: u64,
    pub provenance: Provenance,
    pub request_sent_seq: u64,
}

impl RequestSnapshot {
    /// Request total: confirmed known tokens only. `None` when no confirmed source is known.
    pub fn confirmed_tokens(&self) -> Option<u64> {
        sum_known(&self.confirmed)
    }

    /// Candidate evidence total, kept distinct from the request total.
    pub fn candidate_tokens(&self) -> Option<u64> {
        sum_known(&self.candidate)
    }
}

fn sum_known(sources: &[SnapshotSource]) -> Option<u64> {
    let mut total = 0u64;
    let mut any = false;
    for source in sources {
        if let Some(tokens) = source.token_count {
            total = total.saturating_add(tokens);
            any = true;
        }
    }
    any.then_some(total)
}

/// Explicit inputs for `recordRequestSnapshot`. Inclusion is written only here; ingest
/// never confirms.
pub struct RecordRequestInput<'a> {
    pub request_id: String,
    pub sent_at_ms: u64,
    pub model_id: Option<String>,
    pub usable_budget_tokens: Option<u64>,
    pub confirmed_source_keys: &'a [String],
    pub candidate_source_keys: &'a [String],
    pub unknown_source_count: u64,
    pub provenance: Provenance,
}

/// Why a snapshot could not be recorded. All map to client `badRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    OverlappingKeys(String),
    UnknownSourceKey(String),
    ConfirmRequiresProvenance(String),
    BudgetWithoutModel,
}

impl SnapshotError {
    pub fn message(&self) -> String {
        match self {
            Self::OverlappingKeys(key) => {
                format!("sourceKey '{key}' is both confirmed and candidate")
            }
            Self::UnknownSourceKey(key) => format!("sourceKey '{key}' was not previously ingested"),
            Self::ConfirmRequiresProvenance(key) => {
                format!(
                    "cannot confirm sourceKey '{key}': ambient direct_api provenance is candidate-only"
                )
            }
            Self::BudgetWithoutModel => "usableBudgetTokens requires a known modelId".to_owned(),
        }
    }
}

/// Build an immutable request snapshot from explicit inclusion evidence. Confirmation
/// requires the stored measurement's provenance to be participant or diagnostic; ambient
/// direct-API sources can only be candidate evidence.
pub fn build_request_snapshot(
    store: &CandidateStore,
    input: RecordRequestInput<'_>,
    request_sent_seq: u64,
) -> Result<RequestSnapshot, SnapshotError> {
    if input.usable_budget_tokens.is_some() && input.model_id.is_none() {
        return Err(SnapshotError::BudgetWithoutModel);
    }
    for key in input.confirmed_source_keys {
        if input.candidate_source_keys.contains(key) {
            return Err(SnapshotError::OverlappingKeys(key.clone()));
        }
    }

    let mut confirmed = Vec::with_capacity(input.confirmed_source_keys.len());
    for key in input.confirmed_source_keys {
        let measurement = store
            .get(key)
            .ok_or_else(|| SnapshotError::UnknownSourceKey(key.clone()))?;
        if !matches!(
            measurement.provenance,
            Provenance::Participant | Provenance::Diagnostic
        ) {
            return Err(SnapshotError::ConfirmRequiresProvenance(key.clone()));
        }
        confirmed.push(snapshot_source(measurement, Inclusion::Confirmed));
    }

    let mut candidate = Vec::with_capacity(input.candidate_source_keys.len());
    for key in input.candidate_source_keys {
        let measurement = store
            .get(key)
            .ok_or_else(|| SnapshotError::UnknownSourceKey(key.clone()))?;
        candidate.push(snapshot_source(measurement, Inclusion::Candidate));
    }

    Ok(RequestSnapshot {
        request_id: input.request_id,
        sent_at_ms: input.sent_at_ms,
        model_id: input.model_id,
        usable_budget_tokens: input.usable_budget_tokens,
        confirmed,
        candidate,
        unknown_source_count: input.unknown_source_count,
        provenance: input.provenance,
        request_sent_seq,
    })
}

fn snapshot_source(measurement: &SourceMeasurement, inclusion: Inclusion) -> SnapshotSource {
    SnapshotSource {
        source_key: measurement.source_key.clone(),
        source_kind: measurement.source_kind,
        token_count: measurement.token_count,
        measurement: measurement.measurement,
        coverage: measurement.coverage,
        inclusion,
        provenance: measurement.provenance,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measurement(source_key: &str, tokens: Option<u64>) -> SourceMeasurement {
        SourceMeasurement {
            source_key: source_key.into(),
            source_kind: SourceKind::Selection,
            token_count: tokens,
            tokenizer_id: tokens.map(|_| "fallback-bpe".into()),
            byte_count: None,
            measurement: if tokens.is_some() {
                Measurement::Estimated
            } else {
                Measurement::Unknown
            },
            coverage: Coverage::Partial,
            provenance: Provenance::DirectApi,
            observed_at_ms: 1,
        }
    }

    #[test]
    fn source_kind_wire_round_trips() {
        for kind in [
            SourceKind::ToolResults,
            SourceKind::Prompt,
            SourceKind::Instructions,
            SourceKind::Unknown,
        ] {
            assert_eq!(SourceKind::from_wire(kind.as_wire()), Some(kind));
        }
        assert_eq!(SourceKind::from_wire("nope"), None);
    }

    #[test]
    fn gauge_replaces_rather_than_sums_repeated_observations() {
        let mut store = CandidateStore::new();
        store.observe(measurement("k1", Some(100)));
        store.observe(measurement("k1", Some(250)));
        assert_eq!(store.len(), 1);
        assert_eq!(store.total_known_tokens(), Some(250));
    }

    #[test]
    fn revision_bumps_on_change_and_holds_on_idempotent_reobserve() {
        let mut store = CandidateStore::new();
        let first = store.observe(measurement("k1", Some(100)));
        let same = store.observe(measurement("k1", Some(100)));
        assert_eq!(first, same);
        let changed = store.observe(measurement("k1", Some(101)));
        assert_eq!(changed, first + 1);
    }

    #[test]
    fn tracks_unknown_sources_separately_from_known_total() {
        let mut store = CandidateStore::new();
        store.observe(measurement("known", Some(80)));
        store.observe(measurement("unknown", None));
        assert_eq!(store.total_known_tokens(), Some(80));
        assert_eq!(store.unknown_source_count(), 1);
    }

    fn stored(store: &mut CandidateStore, key: &str, tokens: Option<u64>, provenance: Provenance) {
        store.observe(SourceMeasurement {
            source_key: key.into(),
            source_kind: SourceKind::Selection,
            token_count: tokens,
            tokenizer_id: None,
            byte_count: None,
            measurement: Measurement::Estimated,
            coverage: Coverage::Complete,
            provenance,
            observed_at_ms: 1,
        });
    }

    fn input<'a>(confirmed: &'a [String], candidate: &'a [String]) -> RecordRequestInput<'a> {
        RecordRequestInput {
            request_id: "01REQ".into(),
            sent_at_ms: 10,
            model_id: Some("gpt-4o".into()),
            usable_budget_tokens: None,
            confirmed_source_keys: confirmed,
            candidate_source_keys: candidate,
            unknown_source_count: 0,
            provenance: Provenance::Participant,
        }
    }

    #[test]
    fn snapshot_confirms_participant_sources_and_totals_confirmed_only() {
        let mut store = CandidateStore::new();
        stored(&mut store, "c1", Some(100), Provenance::Participant);
        stored(&mut store, "a1", Some(400), Provenance::DirectApi);
        let confirmed = vec!["c1".to_owned()];
        let candidate = vec!["a1".to_owned()];
        let snapshot = build_request_snapshot(&store, input(&confirmed, &candidate), 42).unwrap();
        assert_eq!(snapshot.confirmed_tokens(), Some(100));
        assert_eq!(snapshot.candidate_tokens(), Some(400));
        assert_eq!(snapshot.request_sent_seq, 42);
    }

    #[test]
    fn snapshot_refuses_to_confirm_ambient_direct_api_source() {
        let mut store = CandidateStore::new();
        stored(&mut store, "a1", Some(400), Provenance::DirectApi);
        let confirmed = vec!["a1".to_owned()];
        let err = build_request_snapshot(&store, input(&confirmed, &[]), 1).unwrap_err();
        assert_eq!(err, SnapshotError::ConfirmRequiresProvenance("a1".into()));
    }

    #[test]
    fn snapshot_rejects_overlapping_and_unknown_keys_and_budget_without_model() {
        let mut store = CandidateStore::new();
        stored(&mut store, "c1", Some(100), Provenance::Participant);

        let both = vec!["c1".to_owned()];
        assert_eq!(
            build_request_snapshot(&store, input(&both, &both), 1).unwrap_err(),
            SnapshotError::OverlappingKeys("c1".into())
        );

        let missing = vec!["nope".to_owned()];
        assert_eq!(
            build_request_snapshot(&store, input(&missing, &[]), 1).unwrap_err(),
            SnapshotError::UnknownSourceKey("nope".into())
        );

        let mut budget_input = input(&[], &[]);
        budget_input.model_id = None;
        budget_input.usable_budget_tokens = Some(8000);
        assert_eq!(
            build_request_snapshot(&store, budget_input, 1).unwrap_err(),
            SnapshotError::BudgetWithoutModel
        );
    }

    #[test]
    fn purge_older_than_removes_stale_sources_and_bumps_revision() {
        let mut store = CandidateStore::new();
        store.observe(SourceMeasurement {
            source_key: "k1".into(),
            source_kind: SourceKind::Selection,
            token_count: Some(100),
            tokenizer_id: None,
            byte_count: None,
            measurement: Measurement::Estimated,
            coverage: Coverage::Complete,
            provenance: Provenance::DirectApi,
            observed_at_ms: 1,
        });
        store.observe(SourceMeasurement {
            source_key: "k2".into(),
            source_kind: SourceKind::Selection,
            token_count: Some(50),
            tokenizer_id: None,
            byte_count: None,
            measurement: Measurement::Estimated,
            coverage: Coverage::Complete,
            provenance: Provenance::DirectApi,
            observed_at_ms: 10_000,
        });
        let rev_before = store.revision();
        let rev_after = store.purge_older_than(5_000);
        assert_eq!(store.len(), 1);
        assert!(rev_after > rev_before);
    }
}
