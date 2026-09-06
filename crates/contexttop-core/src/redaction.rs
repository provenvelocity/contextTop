//! Bounded, built-in redaction applied to transient content before any optional detail
//! storage. Raw content is never persisted; this module only sanitizes the short-lived
//! in-memory buffer the engine tokenizes, so that if a later tier ever stores redacted
//! detail it cannot leak secrets or absolute paths.
//!
//! v1 ships a small, conservative rule set. User-defined rules are Phase 2.

/// A single redaction rule: a matcher and the placeholder that replaces every match.
pub trait RedactionRule {
    /// Replace every sensitive span in `input`, returning the sanitized string.
    fn apply(&self, input: &str) -> String;
    /// Stable identifier for diagnostics/tests.
    fn id(&self) -> &'static str;
}

/// Redacts common secret-bearing tokens: bearer tokens, API keys, and `key=value`
/// secrets. Intentionally conservative — it prefers over-redaction to leakage.
pub struct SecretRule;

impl RedactionRule for SecretRule {
    fn id(&self) -> &'static str {
        "secret"
    }

    fn apply(&self, input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        for line in input.split_inclusive('\n') {
            out.push_str(&redact_secrets_in_line(line));
        }
        out
    }
}

/// Redacts absolute filesystem paths (POSIX and Windows) to a placeholder, so retained
/// detail never carries a user's directory layout.
pub struct PathRule;

impl RedactionRule for PathRule {
    fn id(&self) -> &'static str {
        "path"
    }

    fn apply(&self, input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        for token in split_keep_delims(input) {
            if is_absolute_path(token) {
                out.push_str("«path»");
            } else {
                out.push_str(token);
            }
        }
        out
    }
}

/// The default engine redactor: secrets first, then paths.
pub struct Redactor {
    rules: Vec<Box<dyn RedactionRule + Send + Sync>>,
}

impl Default for Redactor {
    fn default() -> Self {
        Self {
            rules: vec![Box::new(SecretRule), Box::new(PathRule)],
        }
    }
}

impl Redactor {
    /// Apply every rule in order.
    pub fn redact(&self, input: &str) -> String {
        let mut current = input.to_owned();
        for rule in &self.rules {
            current = rule.apply(&current);
        }
        current
    }
}

/// True when a whitespace-delimited token looks like an absolute path.
fn is_absolute_path(token: &str) -> bool {
    let t = token.trim();
    if t.len() < 4 {
        return false;
    }
    // POSIX: /a/b ; Windows: C:\a\b or C:/a/b
    let posix = t.starts_with('/') && t[1..].contains('/');
    let win = {
        let bytes = t.as_bytes();
        bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/')
    };
    posix || win
}

/// Redact secrets on a single line: `Authorization: Bearer x`, `key=SECRET`, long hex/base64
/// tokens that follow a secret-ish label.
fn redact_secrets_in_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let looks_secret = ["authorization", "bearer", "api_key", "apikey", "secret", "token", "password", "passwd"]
        .iter()
        .any(|k| lower.contains(k));
    if !looks_secret {
        return line.to_owned();
    }
    // Replace the value after a `:` or `=` on a secret-labeled line.
    if let Some(pos) = line.find(['=', ':']) {
        let (head, tail) = line.split_at(pos + 1);
        let trailing_ws: String = tail.chars().rev().take_while(|c| c.is_whitespace()).collect();
        let mut redacted = String::with_capacity(line.len());
        redacted.push_str(head);
        if !tail.trim().is_empty() {
            redacted.push_str(" «redacted»");
        }
        redacted.push_str(&trailing_ws.chars().rev().collect::<String>());
        return redacted;
    }
    line.to_owned()
}

/// Split on whitespace boundaries while keeping the delimiters, so reconstruction preserves
/// spacing.
fn split_keep_delims(input: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_ws = input.chars().next().map(|c| c.is_whitespace()).unwrap_or(false);
    for (i, c) in input.char_indices() {
        let ws = c.is_whitespace();
        if ws != in_ws {
            out.push(&input[start..i]);
            start = i;
            in_ws = ws;
        }
    }
    if start < input.len() {
        out.push(&input[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_token() {
        let r = Redactor::default();
        let out = r.redact("Authorization: Bearer abc123SECRETtoken");
        assert!(!out.contains("abc123SECRETtoken"), "token leaked: {out}");
        assert!(out.contains("«redacted»"));
    }

    #[test]
    fn redacts_key_value_secret() {
        let r = Redactor::default();
        let out = r.redact("api_key=sk-verysecretvalue");
        assert!(!out.contains("sk-verysecretvalue"), "secret leaked: {out}");
    }

    #[test]
    fn redacts_absolute_paths() {
        let r = Redactor::default();
        let out = r.redact("see /Users/alice/secret/project/main.rs for details");
        assert!(!out.contains("/Users/alice"), "path leaked: {out}");
        assert!(out.contains("«path»"));
    }

    #[test]
    fn leaves_ordinary_text_untouched() {
        let r = Redactor::default();
        let input = "the quick brown fox jumps over 42 lazy dogs";
        assert_eq!(r.redact(input), input);
    }

    #[test]
    fn windows_path_redacted() {
        let r = Redactor::default();
        let out = r.redact("open C:\\Users\\bob\\file.txt now");
        assert!(!out.contains("C:\\Users\\bob"), "win path leaked: {out}");
    }
}
