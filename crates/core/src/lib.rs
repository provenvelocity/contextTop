use std::collections::{BTreeMap, BTreeSet};

use contexttop_protocol::{
    Confidence, ContextBucket, ContextEvent, EventKind, FixDisposition, FixKind, FixScope,
    Recommendation, SourceKind,
};

const WINDOW_MS: u64 = 5_000;

#[derive(Debug, Default)]
pub struct Aggregator {
    events: Vec<ContextEvent>,
}

impl Aggregator {
    pub fn record(&mut self, event: ContextEvent) {
        self.events.push(event);
    }

    pub fn buckets(&self, session_id: &str) -> Vec<ContextBucket> {
        let mut grouped: BTreeMap<u64, Vec<&ContextEvent>> = BTreeMap::new();
        for event in self
            .events
            .iter()
            .filter(|event| event.session_id == session_id)
        {
            grouped
                .entry(window_start(event.timestamp_ms))
                .or_default()
                .push(event);
        }

        grouped
            .into_iter()
            .map(|(window_start_ms, events)| build_bucket(window_start_ms, session_id, events))
            .collect()
    }
}

pub fn recommendations(bucket: &ContextBucket) -> Vec<Recommendation> {
    let mut result = Vec::new();
    add_recommendation(
        &mut result,
        bucket,
        SourceKind::Terminal,
        2_000,
        FixKind::FocusTerminal,
        "Summarize large terminal output",
        FixScope::CurrentRequest,
        "Terminal output is large enough to warrant a focused redacted summary",
    );
    add_recommendation(
        &mut result,
        bucket,
        SourceKind::History,
        4_000,
        FixKind::HandoffHistory,
        "Create a concise chat handoff",
        FixScope::NewChat,
        "Prior chat history is consuming a large share of estimated context",
    );
    add_recommendation(
        &mut result,
        bucket,
        SourceKind::Files,
        3_000,
        FixKind::DetachFiles,
        "Review detachable files",
        FixScope::CurrentRequest,
        "Attached files exceed the review threshold for the current request",
    );
    add_recommendation(
        &mut result,
        bucket,
        SourceKind::Tools,
        1_500,
        FixKind::ReduceTools,
        "Review enabled tools",
        FixScope::CurrentAgentSession,
        "Tool definitions are large enough to review for relevance",
    );
    add_recommendation(
        &mut result,
        bucket,
        SourceKind::Files,
        8_000,
        FixKind::ExcludeGeneratedFiles,
        "Preview generated-file exclusions",
        FixScope::WorkspaceSettings,
        "File context is large enough to inspect generated-file exclusion rules",
    );
    result.sort_by_key(|item| std::cmp::Reverse(item.expected_savings));
    result
}

fn add_recommendation(
    result: &mut Vec<Recommendation>,
    bucket: &ContextBucket,
    source_kind: SourceKind,
    threshold: u64,
    kind: FixKind,
    title: &str,
    scope: FixScope,
    evidence: &str,
) {
    let Some(&tokens) = bucket.token_by_source_kind.get(&source_kind) else {
        return;
    };
    if tokens < threshold {
        return;
    }
    result.push(Recommendation {
        id: format!("fix-{}-{}", bucket.window_start_ms, kind_name(&kind)),
        kind,
        title: title.into(),
        scope,
        evidence: evidence.into(),
        expected_savings: tokens / 2,
        reversible: true,
        disposition: FixDisposition::Advisory,
    });
}

fn kind_name(kind: &FixKind) -> &'static str {
    match kind {
        FixKind::FocusTerminal => "terminal",
        FixKind::HandoffHistory => "history",
        FixKind::ExcludeGeneratedFiles => "generated-files",
        FixKind::ReduceTools => "tools",
        FixKind::DetachFiles => "files",
    }
}

fn window_start(timestamp_ms: u64) -> u64 {
    timestamp_ms / WINDOW_MS * WINDOW_MS
}

fn build_bucket(
    window_start_ms: u64,
    session_id: &str,
    events: Vec<&ContextEvent>,
) -> ContextBucket {
    let mut token_by_source_kind = BTreeMap::new();
    let mut request_ids = BTreeSet::new();
    let mut fix_ids = BTreeSet::new();
    let mut confidence_summary = Confidence::Observed;

    for event in events {
        confidence_summary = confidence_summary.max(event.confidence);
        if let Some(token_count) = event.token_count {
            *token_by_source_kind
                .entry(event.source_kind.unwrap_or(SourceKind::Unknown))
                .or_insert(0) += token_count;
        }
        if let Some(request_id) = &event.request_id {
            if matches!(
                event.event_kind,
                EventKind::RequestStarted
                    | EventKind::RequestSent
                    | EventKind::ResponseStarted
                    | EventKind::RequestCompleted
                    | EventKind::ToolStarted
                    | EventKind::ToolFinished
            ) {
                request_ids.insert(request_id.clone());
            }
        }
        if matches!(
            event.event_kind,
            EventKind::FixProposed | EventKind::FixApplied
        ) {
            if let Some(fix_id) = &event.request_id {
                fix_ids.insert(fix_id.clone());
            }
        }
    }

    ContextBucket {
        window_start_ms,
        session_id: session_id.to_string(),
        token_total_estimated: token_by_source_kind.values().sum(),
        token_by_source_kind,
        confidence_summary,
        request_ids: request_ids.into_iter().collect(),
        fix_ids: fix_ids.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(
        timestamp_ms: u64,
        source_kind: SourceKind,
        token_count: u64,
        confidence: Confidence,
    ) -> ContextEvent {
        ContextEvent {
            timestamp_ms,
            session_id: "session-1".into(),
            request_id: Some("request-1".into()),
            event_kind: EventKind::SourceChanged,
            source_kind: Some(source_kind),
            token_count: Some(token_count),
            confidence,
            source_fingerprint: None,
            metadata_redacted: json!({}),
        }
    }

    #[test]
    fn aligns_events_to_epoch_windows_and_recomputes_late_events() {
        let mut aggregator = Aggregator::default();
        aggregator.record(event(4_999, SourceKind::Prompt, 10, Confidence::Estimated));
        aggregator.record(event(5_000, SourceKind::Tools, 20, Confidence::Observed));
        aggregator.record(event(1, SourceKind::Selection, 5, Confidence::Partial));

        let buckets = aggregator.buckets("session-1");
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].window_start_ms, 0);
        assert_eq!(buckets[0].token_total_estimated, 15);
        assert_eq!(buckets[0].confidence_summary, Confidence::Partial);
        assert_eq!(buckets[1].window_start_ms, 5_000);
        assert_eq!(buckets[1].token_total_estimated, 20);
    }

    #[test]
    fn ranks_reversible_advisories_by_expected_savings() {
        let bucket = ContextBucket {
            window_start_ms: 5_000,
            session_id: "session-1".into(),
            token_total_estimated: 10_000,
            token_by_source_kind: BTreeMap::from([
                (SourceKind::Tools, 2_000),
                (SourceKind::Terminal, 4_000),
            ]),
            confidence_summary: Confidence::Estimated,
            request_ids: Vec::new(),
            fix_ids: Vec::new(),
        };
        let fixes = recommendations(&bucket);
        assert_eq!(fixes.len(), 2);
        assert_eq!(fixes[0].kind, FixKind::FocusTerminal);
        assert!(
            fixes
                .iter()
                .all(|fix| fix.reversible && fix.disposition == FixDisposition::Advisory)
        );
    }
}
