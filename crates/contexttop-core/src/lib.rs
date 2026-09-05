//! Context accounting primitives shared by VS Code and future native clients.

use std::collections::{BTreeMap, BTreeSet};

pub const DISPLAY_WINDOW_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    Observed,
    Estimated,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextEvent {
    pub timestamp_ms: u64,
    pub session_id: String,
    pub request_id: Option<String>,
    pub source_kind: SourceKind,
    pub token_count: u32,
    pub confidence: Confidence,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextBucket {
    pub window_start_ms: u64,
    pub session_id: String,
    pub token_total: u32,
    pub tokens_by_source: BTreeMap<SourceKind, u32>,
    pub request_ids: BTreeSet<String>,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recommendation {
    pub title: String,
    pub detail: String,
    pub source_kind: SourceKind,
    pub estimated_tokens_saved: u32,
}

pub fn window_start(timestamp_ms: u64) -> u64 {
    timestamp_ms / DISPLAY_WINDOW_MS * DISPLAY_WINDOW_MS
}

pub fn bucket_events(events: &[ContextEvent]) -> Vec<ContextBucket> {
    let mut buckets: BTreeMap<(String, u64), ContextBucket> = BTreeMap::new();

    for event in events {
        let key = (event.session_id.clone(), window_start(event.timestamp_ms));
        let bucket = buckets.entry(key).or_insert_with(|| ContextBucket {
            window_start_ms: window_start(event.timestamp_ms),
            session_id: event.session_id.clone(),
            token_total: 0,
            tokens_by_source: BTreeMap::new(),
            request_ids: BTreeSet::new(),
            confidence: event.confidence,
        });

        bucket.token_total = bucket.token_total.saturating_add(event.token_count);
        *bucket.tokens_by_source.entry(event.source_kind).or_default() += event.token_count;
        if let Some(request_id) = &event.request_id {
            bucket.request_ids.insert(request_id.clone());
        }
        bucket.confidence = merge_confidence(bucket.confidence, event.confidence);
    }

    buckets.into_values().collect()
}

pub fn recommend(events: &[ContextEvent]) -> Vec<Recommendation> {
    let mut totals: BTreeMap<SourceKind, u32> = BTreeMap::new();
    for event in events {
        *totals.entry(event.source_kind).or_default() += event.token_count;
    }

    let rules = [
        (SourceKind::Terminal, "Summarize terminal output", "Keep only the failing command and relevant error block."),
        (SourceKind::History, "Start a clean chat handoff", "Replace stale chat turns with a compact task summary."),
        (SourceKind::Tools, "Review enabled tools", "Disable tools unrelated to the current task."),
        (SourceKind::Files, "Review attached files", "Detach generated or irrelevant files before sending."),
    ];

    rules.into_iter().filter_map(|(source_kind, title, detail)| {
        let tokens = totals.get(&source_kind).copied().unwrap_or_default();
        (tokens >= 1_000).then(|| Recommendation {
            title: title.to_owned(),
            detail: detail.to_owned(),
            source_kind,
            estimated_tokens_saved: (tokens as f32 * 0.75) as u32,
        })
    }).collect()
}

fn merge_confidence(current: Confidence, incoming: Confidence) -> Confidence {
    use Confidence::*;
    match (current, incoming) {
        (Unknown, _) | (_, Unknown) => Unknown,
        (Partial, _) | (_, Partial) => Partial,
        (Estimated, _) | (_, Estimated) => Estimated,
        _ => Observed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(timestamp_ms: u64, kind: SourceKind, tokens: u32) -> ContextEvent {
        ContextEvent { timestamp_ms, session_id: "session-1".into(), request_id: Some("request-1".into()), source_kind: kind, token_count: tokens, confidence: Confidence::Estimated, label: "test".into() }
    }

    #[test]
    fn aggregates_events_into_fixed_five_second_windows() {
        let buckets = bucket_events(&[event(4_999, SourceKind::Files, 900), event(5_000, SourceKind::Terminal, 1_200)]);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].window_start_ms, 0);
        assert_eq!(buckets[1].window_start_ms, 5_000);
    }

    #[test]
    fn proposes_fixes_for_material_context_sources() {
        let fixes = recommend(&[event(0, SourceKind::Terminal, 4_000), event(0, SourceKind::Prompt, 200)]);
        assert_eq!(fixes.len(), 1);
        assert_eq!(fixes[0].title, "Summarize terminal output");
        assert_eq!(fixes[0].estimated_tokens_saved, 3_000);
    }
}
