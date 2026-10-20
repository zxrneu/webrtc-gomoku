//! Startup-only HTTPS configuration, independent of hot-reloaded game settings.
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig;

use crate::config::EnvSource;

/// PEM files resolved relative to an explicitly selected repository/deployment root.
#[derive(Debug, PartialEq, Eq)]
pub struct TlsFiles {
    pub cert: PathBuf,
    pub key: PathBuf,
}

impl TlsFiles {
    /// Missing or incomplete settings never silently downgrade an intended HTTPS listener.
    pub fn from_env(env: &dyn EnvSource, root: &Path) -> io::Result<Option<Self>> {
        let cert = nonempty(env, "TLS_CERT_FILE");
        let key = nonempty(env, "TLS_KEY_FILE");
        match (cert, key) {
            (None, None) => Ok(None),
            (Some(cert), Some(key)) => Ok(Some(Self {
                cert: root.join(cert),
                key: root.join(key),
            })),
            _ => Err(invalid("HTTPS 需要同时配置 TLS_CERT_FILE 和 TLS_KEY_FILE")),
        }
    }
}

/// Find a relocated checkout from cwd, or use cwd for a standalone binary deployment.
/// An explicit GOMOKU_REPO_ROOT overrides discovery without embedding build-machine paths.
pub fn repository_root(env: &dyn EnvSource, cwd: &Path) -> PathBuf {
    if let Some(root) = nonempty(env, "GOMOKU_REPO_ROOT") {
        return cwd.join(root);
    }
    cwd.ancestors()
        .find(|dir| dir.join("pnpm-workspace.yaml").is_file())
        .unwrap_or(cwd)
        .to_path_buf()
}

/// Validate certificate PEM and matching key before any network listener starts.
pub fn load_tls_config(env: &dyn EnvSource, root: &Path) -> io::Result<Option<Arc<ServerConfig>>> {
    let Some(files) = TlsFiles::from_env(env, root)? else {
        return Ok(None);
    };
    let cert_pem = std::fs::read(&files.cert)
        .map_err(|_| invalid("无法读取 TLS_CERT_FILE；请检查路径和权限"))?;
    let key_pem = std::fs::read(&files.key)
        .map_err(|_| invalid("无法读取 TLS_KEY_FILE；请检查路径和权限"))?;
    let certs = CertificateDer::pem_slice_iter(&cert_pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid("TLS_CERT_FILE 不是有效的 PEM 证书链"))?;
    if certs.is_empty() {
        return Err(invalid("TLS_CERT_FILE 不包含 PEM 证书"));
    }
    let key = PrivateKeyDer::from_pem_slice(&key_pem)
        .map_err(|_| invalid("TLS_KEY_FILE 不是受支持的未加密 PEM 私钥"))?;
    let provider = tokio_rustls::rustls::crypto::ring::default_provider();
    let mut config = ServerConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|_| invalid("无法配置 TLS 协议版本"))?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|_| invalid("TLS_CERT_FILE 与 TLS_KEY_FILE 无效或不匹配"))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Some(Arc::new(config)))
}

fn nonempty(env: &dyn EnvSource, key: &str) -> Option<String> {
    env.get(key)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
