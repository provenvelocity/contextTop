//! Context accounting primitives shared by VS Code and future native clients.
//!
//! The domain model follows `docs/arch/METRICS.md`: candidate pressure is a gauge, request
//! source composition is immutable, and measurement/inclusion/coverage are independent
//! axes. The prototype additive event model has been removed.

pub mod model;
pub mod protocol;
pub mod recommend;
pub mod redaction;
pub mod source_key;
pub mod tokenizer;

/// Display projection window: five-second buckets.
pub const DISPLAY_WINDOW_MS: u64 = 5_000;

/// Truncate a timestamp to the start of its display window.
pub fn window_start(timestamp_ms: u64) -> u64 {
    timestamp_ms / DISPLAY_WINDOW_MS * DISPLAY_WINDOW_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_start_truncates_to_five_second_boundary() {
        assert_eq!(window_start(4_999), 0);
        assert_eq!(window_start(5_000), 5_000);
        assert_eq!(window_start(12_345), 10_000);
    }
}
