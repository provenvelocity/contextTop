//! Model-aware token estimation with a conservative fallback. v1 ships only the fallback
//! plus a registry seam; model-specific tokenizers arrive later. See `docs/SIGNALS.md`
//! (Tokenizer strategy). Any fallback result is labeled `estimated` by the caller.

/// Identifier reported for the conservative fallback tokenizer.
pub const FALLBACK_ID: &str = "fallback-bpe";

pub trait TokenizerProvider {
    fn id(&self) -> &str;
    fn count_text(&self, text: &str) -> u64;
    fn count_bytes(&self, byte_len: u64) -> u64;
}

/// Conservative estimate: ~4 bytes per token, rounded up, never zero for nonempty input.
pub fn estimate_tokens(byte_len: u64) -> u64 {
    if byte_len == 0 {
        0
    } else {
        byte_len.div_ceil(4).max(1)
    }
}

pub struct FallbackTokenizer;

impl TokenizerProvider for FallbackTokenizer {
    fn id(&self) -> &str {
        FALLBACK_ID
    }

    fn count_text(&self, text: &str) -> u64 {
        estimate_tokens(text.len() as u64)
    }

    fn count_bytes(&self, byte_len: u64) -> u64 {
        estimate_tokens(byte_len)
    }
}

#[derive(Default)]
pub struct TokenizerRegistry {
    fallback: FallbackTokenizer,
}

impl TokenizerRegistry {
    pub fn new() -> Self {
        Self {
            fallback: FallbackTokenizer,
        }
    }

    /// Resolve a tokenizer for the active model. v1 always returns the conservative
    /// fallback; a match seam for model-specific tokenizers is added later.
    pub fn for_model(&self, _model_id: Option<&str>) -> &dyn TokenizerProvider {
        &self.fallback
    }
}

impl Default for FallbackTokenizer {
    fn default() -> Self {
        FallbackTokenizer
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_zero_tokens() {
        assert_eq!(estimate_tokens(0), 0);
    }

    #[test]
    fn nonempty_input_rounds_up_and_is_never_zero() {
        assert_eq!(estimate_tokens(1), 1);
        assert_eq!(estimate_tokens(4), 1);
        assert_eq!(estimate_tokens(5), 2);
        assert_eq!(estimate_tokens(11), 3);
    }

    #[test]
    fn registry_returns_fallback_for_unknown_model() {
        let registry = TokenizerRegistry::new();
        let tokenizer = registry.for_model(Some("some-future-model"));
        assert_eq!(tokenizer.id(), FALLBACK_ID);
        assert_eq!(tokenizer.count_text("hello world"), 3);
    }
}
