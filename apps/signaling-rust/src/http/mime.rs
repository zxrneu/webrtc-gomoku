//! MIME type table (mirrors `apps/server/src/server.ts`, including `.mjs`).

use std::path::Path;

/// Default content type for unknown extensions.
pub const DEFAULT_MIME: &str = "application/octet-stream";

/// Map a lowercase extension (without the dot) to a content type.
pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        _ => DEFAULT_MIME,
    }
}

/// Content type for a file path (extension matched case-insensitively).
pub fn mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => mime_for_ext(&ext.to_ascii_lowercase()),
        None => DEFAULT_MIME,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mjs_is_javascript() {
        assert_eq!(mime_for_ext("mjs"), "text/javascript; charset=utf-8");
    }

    #[test]
    fn known_extensions_match_ts_server() {
        assert_eq!(mime_for_ext("html"), "text/html; charset=utf-8");
        assert_eq!(mime_for_ext("css"), "text/css; charset=utf-8");
        assert_eq!(mime_for_ext("json"), "application/json; charset=utf-8");
        assert_eq!(mime_for_ext("png"), "image/png");
        assert_eq!(mime_for_ext("svg"), "image/svg+xml");
        assert_eq!(mime_for_ext("ico"), "image/x-icon");
    }

    #[test]
    fn unknown_extension_is_octet_stream() {
        assert_eq!(mime_for_ext("wasm"), DEFAULT_MIME);
        assert_eq!(mime_for_path(Path::new("/a/b/file.unknown")), DEFAULT_MIME);
    }

    #[test]
    fn extension_lookup_is_case_insensitive() {
        assert_eq!(
            mime_for_path(Path::new("INDEX.HTML")),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn no_extension_is_octet_stream() {
        assert_eq!(mime_for_path(Path::new("LICENSE")), DEFAULT_MIME);
    }
}
