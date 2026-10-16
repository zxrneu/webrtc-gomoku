//! Static file hosting with SPA fallback and path-traversal protection.
//!
//! Behaviour mirrors `apps/server/src/server.ts` (architecture §9.9):
//! * `public_dir` fallback probing: `[configured, packages/web/dist, dist, public]`
//! * every 200 response carries `cache-control: no-cache`
//! * a normalized path that escapes the root ⇒ **403 Forbidden**
//! * a missing file *without* extension falls back to `index.html`; with an
//!   extension it is a 404

use std::path::{Component, Path, PathBuf};

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;

use super::mime;

/// Candidate directories, in probe order.
pub fn candidate_dirs(configured: &str) -> Vec<PathBuf> {
    vec![
        PathBuf::from(configured),
        PathBuf::from("packages/web/dist"),
        PathBuf::from("dist"),
        PathBuf::from("public"),
    ]
}

/// Return the first existing candidate, else the last one.
pub fn resolve_public_dir(configured: &str) -> PathBuf {
    let candidates = candidate_dirs(configured);
    for dir in &candidates {
        if dir.is_dir() {
            return dir.clone();
        }
    }
    candidates
        .last()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("public"))
}

/// Lexically normalize a path (resolve `.` / `..` without touching the FS).
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::Normal(c) => out.push(c),
        }
    }
    out
}

/// Percent-decode a URI path (mirrors `decodeURIComponent`, no `+` handling).
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(high * 16 + low);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn build_response(
    status: StatusCode,
    content_type: &str,
    no_cache: bool,
    body: Vec<u8>,
) -> Response {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type);
    if no_cache {
        builder = builder.header(header::CACHE_CONTROL, "no-cache");
    }
    builder
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn plain(status: StatusCode, body: &'static str) -> Response {
    build_response(
        status,
        "text/plain; charset=utf-8",
        false,
        body.as_bytes().to_vec(),
    )
}

/// Serve `raw_path` from `public_dir`.
pub async fn serve(public_dir: &Path, raw_path: &str) -> Response {
    let decoded = percent_decode(raw_path);
    let root = normalize(public_dir);
    let rel = if decoded == "/" || decoded.is_empty() {
        "/index.html".to_string()
    } else {
        decoded
    };
    let target = normalize(&root.join(rel.trim_start_matches('/')));

    if !target.starts_with(&root) {
        return plain(StatusCode::FORBIDDEN, "Forbidden");
    }

    match tokio::fs::read(&target).await {
        Ok(bytes) => build_response(StatusCode::OK, mime::mime_for_path(&target), true, bytes),
        Err(_) => {
            if Path::new(&rel).extension().is_none() {
                // SPA fallback: no extension ⇒ serve index.html.
                let index = root.join("index.html");
                match tokio::fs::read(&index).await {
                    Ok(bytes) => {
                        build_response(StatusCode::OK, "text/html; charset=utf-8", true, bytes)
                    }
                    Err(_) => plain(StatusCode::NOT_FOUND, "Not Found"),
                }
            } else {
                plain(StatusCode::NOT_FOUND, "Not Found")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn body_string(response: Response) -> (StatusCode, String) {
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("index.html"), "<html>root</html>").expect("index");
        std::fs::write(dir.path().join("app.js"), "console.log(1)").expect("app.js");
        std::fs::create_dir_all(dir.path().join("assets")).expect("mkdir");
        std::fs::write(dir.path().join("assets/logo.svg"), "<svg/>").expect("svg");
        dir
    }

    #[tokio::test]
    async fn serves_index_for_root() {
        let dir = fixture();
        let resp = serve(dir.path(), "/").await;
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "<html>root</html>");
    }

    #[tokio::test]
    async fn sets_no_cache_and_correct_mime() {
        let dir = fixture();
        let resp = serve(dir.path(), "/app.js").await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("text/javascript; charset=utf-8")
        );
        assert_eq!(
            resp.headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-cache")
        );
    }

    #[tokio::test]
    async fn missing_file_with_extension_is_404() {
        let dir = fixture();
        let resp = serve(dir.path(), "/nope.js").await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn missing_extensionless_path_falls_back_to_index() {
        let dir = fixture();
        let resp = serve(dir.path(), "/some/spa/route").await;
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "<html>root</html>");
    }

    #[tokio::test]
    async fn path_traversal_is_forbidden() {
        let dir = fixture();
        // Create a secret next to the public root.
        let secret = dir
            .path()
            .parent()
            .expect("parent")
            .join("secret-gomoku.txt");
        std::fs::write(&secret, "top secret").expect("write secret");

        let public = dir.path();
        let raw = format!(
            "/../{}",
            secret.file_name().expect("name").to_string_lossy()
        );
        let resp = serve(public, &raw).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        std::fs::remove_file(&secret).ok();
    }

    #[tokio::test]
    async fn percent_encoded_traversal_is_forbidden() {
        let dir = fixture();
        let resp = serve(dir.path(), "/%2e%2e/secret.txt").await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn percent_decode_handles_utf8_and_plain() {
        assert_eq!(percent_decode("/a%20b"), "/a b");
        assert_eq!(percent_decode("/plain"), "/plain");
        assert_eq!(percent_decode("/%e4%b8%ad"), "/中");
    }

    #[test]
    fn resolve_public_dir_prefers_existing_candidate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let configured = dir.path().to_string_lossy().to_string();
        let resolved = resolve_public_dir(&configured);
        assert_eq!(resolved, PathBuf::from(&configured));
    }

    #[test]
    fn resolve_public_dir_falls_back_when_missing() {
        let resolved = resolve_public_dir("/definitely/does/not/exist/gomoku-xyz");
        assert_eq!(resolved, PathBuf::from("public"));
    }
}
