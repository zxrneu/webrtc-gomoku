//! Room-code and peer-id value objects.
//!
//! * [`RoomCode`] — invariant `[A-Z0-9]{4}` (uppercased on construction).
//! * [`PeerId`] — 8 chars of `[a-z0-9]` (base36, aligned with v1
//!   `Math.random().toString(36).slice(2, 10)`).

use std::fmt;

use rand::Rng;
use thiserror::Error;

/// Number of characters in a room code.
pub const ROOM_CODE_LEN: usize = 4;
/// Number of characters in a peer id.
pub const PEER_ID_LEN: usize = 8;
/// Radix used for generated tokens.
const RADIX: u32 = 36;

/// Error returned when a string is not a valid room code.
#[derive(Debug, Error, PartialEq, Eq, Clone, Copy)]
#[error("房间号格式非法")]
pub struct RoomCodeError;

/// A validated 4-char upper-case room code.
#[derive(Clone, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct RoomCode(String);

impl RoomCode {
    /// Uppercase `input` and validate it as `[A-Z0-9]{4}`.
    pub fn new(input: &str) -> Result<Self, RoomCodeError> {
        let upper = input.to_uppercase();
        if is_valid_room_code(&upper) {
            Ok(RoomCode(upper))
        } else {
            Err(RoomCodeError)
        }
    }

    /// Borrow the code as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RoomCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A validated 8-char base36 peer id.
#[derive(Clone, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct PeerId(String);

impl PeerId {
    /// Validate `input` as `[a-z0-9]{8}`.
    pub fn new(input: &str) -> Result<Self, PeerIdError> {
        if is_valid_peer_id(input) {
            Ok(PeerId(input.to_string()))
        } else {
            Err(PeerIdError)
        }
    }

    /// Borrow the id as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PeerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Error returned when a string is not a valid peer id.
#[derive(Debug, Error, PartialEq, Eq, Clone, Copy)]
#[error("peerId 格式非法")]
pub struct PeerIdError;

/// `true` when `s` is exactly four upper-case ASCII alphanumerics.
pub fn is_valid_room_code(s: &str) -> bool {
    s.chars().count() == ROOM_CODE_LEN
        && s.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// `true` when `s` is exactly eight lower-case ASCII alphanumerics.
pub fn is_valid_peer_id(s: &str) -> bool {
    s.chars().count() == PEER_ID_LEN
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Generate a random token of `len` characters.
///
/// `lowercase` selects `[a-z0-9]`; otherwise `[A-Z0-9]`.
pub fn random_token(len: usize, lowercase: bool) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| {
            let n = rng.gen_range(0..RADIX);
            let c = std::char::from_digit(n, RADIX).unwrap_or('0');
            if lowercase {
                c
            } else {
                c.to_ascii_uppercase()
            }
        })
        .collect()
}

/// Generate a fresh 4-char room code (`36^4` space).
pub fn generate_room_code() -> RoomCode {
    RoomCode(random_token(ROOM_CODE_LEN, false))
}

/// Generate a fresh 8-char peer id.
pub fn generate_peer_id() -> PeerId {
    PeerId(random_token(PEER_ID_LEN, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_code_uppercases_input() {
        assert_eq!(RoomCode::new("abcd").expect("ok").as_str(), "ABCD");
        assert_eq!(RoomCode::new("Ab1Z").expect("ok").as_str(), "AB1Z");
    }

    #[test]
    fn room_code_rejects_bad_format() {
        for bad in ["", "ABC", "ABCDE", "AB-D", "ab d", "汉字AB"] {
            assert!(RoomCode::new(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn generated_room_code_is_valid() {
        for _ in 0..200 {
            let code = generate_room_code();
            assert!(is_valid_room_code(code.as_str()));
        }
    }

    #[test]
    fn generated_peer_id_is_valid() {
        for _ in 0..200 {
            let id = generate_peer_id();
            assert!(is_valid_peer_id(id.as_str()));
        }
    }

    #[test]
    fn peer_id_rejects_uppercase_and_bad_length() {
        assert!(PeerId::new("ABCD1234").is_err());
        assert!(PeerId::new("abc").is_err());
        assert!(PeerId::new("abcdefgh").is_ok());
    }

    #[test]
    fn random_token_respects_case() {
        let upper = random_token(8, false);
        let lower = random_token(8, true);
        assert_eq!(upper.len(), 8);
        assert!(upper
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
        assert!(lower
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    }
}
