pub fn estimate_tokens(text: &str) -> u64 {
    if text.is_empty() {
        0
    } else {
        ((text.chars().count() as u64) + 3) / 4
    }
}
