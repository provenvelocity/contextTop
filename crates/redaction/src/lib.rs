pub fn redact(value: &str) -> String {
    let mut output = value.to_string();
    for prefix in ["ghp_", "github_pat_", "sk-"] {
        output = redact_prefixed(&output, prefix);
    }
    output
}

fn redact_prefixed(value: &str, prefix: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut remaining = value;
    while let Some(index) = remaining.find(prefix) {
        output.push_str(&remaining[..index]);
        let secret_end = remaining[index..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '"' | '\'' | ',' | ';')
            })
            .map(|offset| index + offset)
            .unwrap_or(remaining.len());
        output.push_str("[REDACTED]");
        remaining = &remaining[secret_end..];
    }
    output.push_str(remaining);
    output
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redacts_common_token_prefixes() {
        assert_eq!(redact("token ghp_abc123 done"), "token [REDACTED] done");
        assert_eq!(redact("key sk-secret;"), "key [REDACTED];");
    }
}
