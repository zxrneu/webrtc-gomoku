//! Strict additive lobby input codec.
use crate::protocol::ServerMsg;
use crate::rooms::RoomCode;
use crate::transport::ConnCtx;
use regex_automata::meta::Regex;
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub(super) enum Command {
    #[serde(rename = "lobby-enter")]
    Enter {
        name: String,
        #[serde(rename = "browserId")]
        browser_id: String,
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    #[serde(rename = "lobby-list")]
    List {
        #[serde(default)]
        query: String,
        #[serde(default, rename = "onlyAvailable")]
        only_available: bool,
        #[serde(default)]
        offset: usize,
    },
    #[serde(rename = "lobby-name")]
    Name { name: String },
    #[serde(rename = "lobby-invite")]
    Invite { target: String },
    #[serde(rename = "lobby-respond")]
    Respond { id: String, accept: bool },
    #[serde(rename = "lobby-cancel")]
    Cancel { id: String },
    #[serde(rename = "lobby-match")]
    Match { action: String },
    #[serde(rename = "lobby-create")]
    Create { public: bool },
    #[serde(rename = "lobby-join")]
    Join { room: String },
    #[serde(rename = "lobby-visibility")]
    Visibility { public: bool },
    #[serde(rename = "lobby-ready")]
    Ready { ready: bool },
}
impl Command {
    pub(super) fn valid(&self) -> bool {
        match self {
            Self::Enter {
                name,
                browser_id,
                tab_id,
            } => valid_name(name) && valid_text(browser_id) && valid_text(tab_id),
            Self::Name { name } => valid_name(name),
            Self::List { query, offset, .. } => {
                query.encode_utf16().count() <= 40 && *offset <= 100000
            }
            Self::Invite { target } => valid_text(target),
            Self::Respond { id, .. } | Self::Cancel { id } => valid_text(id),
            Self::Match { action } => action == "join" || action == "leave",
            Self::Join { room } => RoomCode::new(room)
                .map(|r| r.as_str() == room)
                .unwrap_or(false),
            _ => true,
        }
    }
}
fn valid_name(name: &str) -> bool {
    // Match the TS codec's Unicode General_Category L/N, not the broader
    // Alphabetic property used by char::is_alphanumeric (which includes Mn).
    static NAME_PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    if name.len() > 48 {
        return false;
    }
    NAME_PATTERN
        .get_or_init(|| Regex::new(r"\A[\p{L}\p{N}_]{2,12}\z").ok())
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(name))
}
fn valid_text(s: &str) -> bool {
    !s.is_empty() && s.encode_utf16().count() <= 100
}
pub(super) fn notice(ctx: &ConnCtx, code: &str, message: &str) {
    ctx.send(ServerMsg::LobbyNotice {
        code: code.into(),
        message: message.into(),
    });
}
