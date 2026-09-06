//! Rank-only recommendation logic. The engine identifies context pressure and proposes
//! reversible actions; it never applies them. There is no `applyFix` RPC. See
//! `docs/PRODUCT.md` and `docs/IPC.md` (`response.recommendations`).

use crate::model::{Measurement, SourceKind};

/// How the adapter would carry out a proposed action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Execution {
    Executable,
    Guided,
    Unsupported,
}

impl Execution {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Executable => "executable",
            Self::Guided => "guided",
            Self::Unsupported => "unsupported",
        }
    }
}

/// The supported action contracts the adapter knows how to present.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    SummarizeTerminal,
    StartCleanChat,
    ProposeExclusion,
    UnselectTools,
    DetachFiles,
}

impl ActionKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::SummarizeTerminal => "summarize_terminal",
            Self::StartCleanChat => "start_clean_chat",
            Self::ProposeExclusion => "propose_exclusion",
            Self::UnselectTools => "unselect_tools",
            Self::DetachFiles => "detach_files",
        }
    }
}

/// One ranked recommendation, before the engine attaches identity (`fixId`, basis,
/// `policyRevision`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recommendation {
    pub action_kind: ActionKind,
    pub title: String,
    pub detail: String,
    pub source_kind: SourceKind,
    pub target_source_keys: Vec<String>,
    pub estimated_tokens_saved_min: u64,
    pub estimated_tokens_saved_max: u64,
    pub measurement: Measurement,
    pub reversible: bool,
    pub execution: Execution,
}

/// A single source considered for ranking, independent of whether it came from a request
/// snapshot or the live candidate gauge.
#[derive(Debug, Clone)]
pub struct RankInput {
    pub source_key: String,
    pub source_kind: SourceKind,
    pub token_count: Option<u64>,
    pub measurement: Measurement,
}

struct Rule {
    kind: SourceKind,
    action: ActionKind,
    title: &'static str,
    detail: &'static str,
    execution: Execution,
}

const RULES: [Rule; 4] = [
    Rule {
        kind: SourceKind::Terminal,
        action: ActionKind::SummarizeTerminal,
        title: "Summarize terminal output",
        detail: "Keep only the failing command and relevant error block.",
        execution: Execution::Guided,
    },
    Rule {
        kind: SourceKind::History,
        action: ActionKind::StartCleanChat,
        title: "Start a clean chat handoff",
        detail: "Replace stale chat turns with a compact task summary.",
        execution: Execution::Guided,
    },
    Rule {
        kind: SourceKind::Tools,
        action: ActionKind::UnselectTools,
        title: "Review enabled tools",
        detail: "Disable tools unrelated to the current task.",
        // Guided: no supported API disables another extension's tools (see docs/PRODUCT.md).
        execution: Execution::Guided,
    },
    Rule {
        kind: SourceKind::Files,
        action: ActionKind::DetachFiles,
        title: "Review attached files",
        detail: "Detach generated or irrelevant files before sending.",
        execution: Execution::Executable,
    },
];

/// Rank pressure by source kind, proposing an action per kind whose known tokens meet
/// `min_tokens`. Results are ordered by descending estimated savings.
pub fn rank(inputs: &[RankInput], min_tokens: u64) -> Vec<Recommendation> {
    let mut proposals = Vec::new();
    for rule in &RULES {
        let matching: Vec<&RankInput> = inputs
            .iter()
            .filter(|input| input.source_kind == rule.kind && input.token_count.is_some())
            .collect();
        let tokens: u64 = matching.iter().filter_map(|input| input.token_count).sum();
        if tokens < min_tokens {
            continue;
        }
        let mut target_source_keys: Vec<String> = matching.iter().map(|input| input.source_key.clone()).collect();
        target_source_keys.sort();
        let measurement = if matching.iter().all(|input| input.measurement == Measurement::Observed) {
            Measurement::Observed
        } else {
            Measurement::Estimated
        };
        proposals.push(Recommendation {
            action_kind: rule.action,
            title: rule.title.to_owned(),
            detail: rule.detail.to_owned(),
            source_kind: rule.kind,
            target_source_keys,
            estimated_tokens_saved_min: tokens / 2,
            estimated_tokens_saved_max: tokens * 9 / 10,
            measurement,
            reversible: true,
            execution: rule.execution,
        });
    }
    proposals.sort_by(|a, b| b.estimated_tokens_saved_max.cmp(&a.estimated_tokens_saved_max));
    proposals
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(key: &str, kind: SourceKind, tokens: u64) -> RankInput {
        RankInput { source_key: key.into(), source_kind: kind, token_count: Some(tokens), measurement: Measurement::Estimated }
    }

    #[test]
    fn proposes_only_for_kinds_over_threshold() {
        let recs = rank(
            &[input("t1", SourceKind::Terminal, 4_000), input("p1", SourceKind::Prompt, 200)],
            1_000,
        );
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].action_kind, ActionKind::SummarizeTerminal);
        assert_eq!(recs[0].estimated_tokens_saved_min, 2_000);
        assert_eq!(recs[0].estimated_tokens_saved_max, 3_600);
    }

    #[test]
    fn aggregates_multiple_sources_of_one_kind_and_sorts_target_keys() {
        let recs = rank(
            &[input("f2", SourceKind::Files, 600), input("f1", SourceKind::Files, 700)],
            1_000,
        );
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].target_source_keys, vec!["f1".to_owned(), "f2".to_owned()]);
        assert_eq!(recs[0].execution, Execution::Executable);
    }

    #[test]
    fn orders_by_descending_estimated_savings() {
        let recs = rank(
            &[input("t1", SourceKind::Terminal, 2_000), input("h1", SourceKind::History, 8_000)],
            1_000,
        );
        assert_eq!(recs[0].action_kind, ActionKind::StartCleanChat);
        assert_eq!(recs[1].action_kind, ActionKind::SummarizeTerminal);
    }

    #[test]
    fn tool_unselect_is_guided() {
        let recs = rank(&[input("tool:a", SourceKind::Tools, 12_000)], 1_000);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].action_kind, ActionKind::UnselectTools);
        // No supported API disables tools, so it must be guided, not executable.
        assert_eq!(recs[0].execution, Execution::Guided);
    }
}
