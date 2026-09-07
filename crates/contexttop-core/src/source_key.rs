//! In-memory session key and `sourceKey` derivation. The engine HMAC-SHA-256s the
//! adapter's `sourceIdentity` with a per-session key; only the lowercase-hex digest of the
//! full 32-byte HMAC is retained. Frozen decision #1 in `docs/arch/ARCHITECTURE.md`.

use std::fmt::Write as _;

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Per-session HMAC key. Held only in memory; a new engine session mints a new key.
pub struct SessionKey([u8; 32]);

impl SessionKey {
    /// Generate a random key from the OS RNG.
    pub fn random() -> Self {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("OS RNG is available");
        Self(bytes)
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Lowercase hex of the full HMAC-SHA-256 digest of `source_identity`, no prefix.
    pub fn derive(&self, source_identity: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.0).expect("HMAC accepts any key length");
        mac.update(source_identity.as_bytes());
        let digest = mac.finalize().into_bytes();
        let mut hex = String::with_capacity(64);
        for byte in digest {
            write!(hex, "{byte:02x}").expect("writing to String cannot fail");
        }
        hex
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic_for_a_fixed_key() {
        let key = SessionKey::from_bytes([7u8; 32]);
        let a = key.derive("file:///workspace/src/app.ts#selection");
        let b = key.derive("file:///workspace/src/app.ts#selection");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(
            a.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }

    #[test]
    fn different_identities_derive_different_keys() {
        let key = SessionKey::from_bytes([7u8; 32]);
        assert_ne!(key.derive("a"), key.derive("b"));
    }

    #[test]
    fn different_session_keys_derive_different_digests() {
        let a = SessionKey::from_bytes([1u8; 32]).derive("same");
        let b = SessionKey::from_bytes([2u8; 32]).derive("same");
        assert_ne!(a, b);
    }
}
