//! TLS settings are validated before the listener is opened.
use std::path::Path;

use gomoku_signaling::config::env::MapEnv;
use gomoku_signaling::http::tls::{load_tls_config, repository_root, TlsFiles};

#[test]
fn no_tls_configuration_preserves_http() {
    assert!(TlsFiles::from_env(&MapEnv::new(&[]), Path::new("repo"))
        .unwrap()
        .is_none());
}

#[test]
fn certificate_and_key_must_be_configured_together() {
    for pair in [("TLS_CERT_FILE", "cert.pem"), ("TLS_KEY_FILE", "key.pem")] {
        let error = TlsFiles::from_env(&MapEnv::new(&[pair]), Path::new("repo")).unwrap_err();
        assert!(error.to_string().contains("TLS_CERT_FILE"));
        assert!(error.to_string().contains("TLS_KEY_FILE"));
    }
}

#[test]
fn relative_certificate_paths_resolve_from_repository_root() {
    let env = MapEnv::new(&[
        ("TLS_CERT_FILE", ".certs/lan-cert.pem"),
        ("TLS_KEY_FILE", ".certs/lan-key.pem"),
    ]);
    let files = TlsFiles::from_env(&env, Path::new("repo"))
        .unwrap()
        .unwrap();
    assert_eq!(files.cert, Path::new("repo/.certs/lan-cert.pem"));
    assert_eq!(files.key, Path::new("repo/.certs/lan-key.pem"));
}

#[test]
fn externally_configured_absolute_paths_are_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let cert = temp.path().join("cert.pem");
    let key = temp.path().join("key.pem");
    let env = MapEnv::new(&[
        ("TLS_CERT_FILE", cert.to_str().unwrap()),
        ("TLS_KEY_FILE", key.to_str().unwrap()),
    ]);
    let files = TlsFiles::from_env(&env, Path::new("repo"))
        .unwrap()
        .unwrap();
    assert_eq!(files.cert, cert);
    assert_eq!(files.key, key);
}

#[test]
fn repository_root_is_found_when_running_from_rust_package() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("pnpm-workspace.yaml"), "packages: []").unwrap();
    let cwd = temp.path().join("apps/signaling-rust");
    assert_eq!(repository_root(&MapEnv::new(&[]), &cwd), temp.path());
}

#[test]
fn standalone_binary_uses_configured_root_or_current_directory() {
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(repository_root(&MapEnv::new(&[]), temp.path()), temp.path());
    let env = MapEnv::new(&[("GOMOKU_REPO_ROOT", "deployment")]);
    assert_eq!(
        repository_root(&env, temp.path()),
        temp.path().join("deployment")
    );
}

#[test]
fn unreadable_certificate_rejects_startup() {
    let temp = tempfile::tempdir().unwrap();
    let env = MapEnv::new(&[
        ("TLS_CERT_FILE", "missing.pem"),
        ("TLS_KEY_FILE", "key.pem"),
    ]);
    assert!(load_tls_config(&env, temp.path())
        .unwrap_err()
        .to_string()
        .contains("TLS_CERT_FILE"));
}

#[test]
fn unreadable_private_key_rejects_startup() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("cert.pem"), "invalid cert").unwrap();
    let env = MapEnv::new(&[
        ("TLS_CERT_FILE", "cert.pem"),
        ("TLS_KEY_FILE", "missing.pem"),
    ]);
    assert!(load_tls_config(&env, temp.path())
        .unwrap_err()
        .to_string()
        .contains("TLS_KEY_FILE"));
}

#[test]
fn invalid_pem_is_rejected_without_logging_its_contents() {
    let temp = tempfile::tempdir().unwrap();
    for name in ["cert.pem", "key.pem"] {
        std::fs::write(temp.path().join(name), "PRIVATE_SENTINEL").unwrap();
    }
    let env = MapEnv::new(&[("TLS_CERT_FILE", "cert.pem"), ("TLS_KEY_FILE", "key.pem")]);
    let error = load_tls_config(&env, temp.path()).unwrap_err().to_string();
    assert!(error.contains("TLS_CERT_FILE"));
    assert!(!error.contains("PRIVATE_SENTINEL"));
}
