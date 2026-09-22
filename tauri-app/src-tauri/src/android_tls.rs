//! Hands Android's certificate store to rustls, once, at startup.
//!
//! reqwest 0.13 verifies server certificates through `rustls-platform-verifier`
//! rather than a CA bundle compiled into the binary. On every other platform the
//! verifier reads the OS trust store on its own; on Android the trust store is
//! only reachable through Java, so the crate needs the process' `JavaVM` and an
//! app `Context` handed to it before the first request.
//!
//! Sync itself goes around this verifier today (`sync_tls_config` below), so the
//! initialisation is not what makes the first sync work. It stays because the
//! bypass is temporary, and anything else that speaks HTTPS from Rust needs it.
//!
//! This has to happen before any HTTPS request, but a `Context` only exists once
//! the activity is up — hence `setup`, not a `ctor`.

use std::sync::OnceLock;

static DONE: OnceLock<()> = OnceLock::new();

/// Idempotent: the verifier keeps a process-wide global and re-initialising it
/// is not defined, while `setup` can run again after the activity is recreated.
pub(crate) fn init() {
    DONE.get_or_init(|| {
        if let Err(e) = install() {
            // Do not abort. Sync stops working, but capture alone still runs.
            // On Android, tao pipes stderr into logcat.
            eprintln!("rustls platform verifier init failed: {e}");
        }
    });
}

/// TLS configuration for the sync client.
///
/// It bypasses the device verifier and validates against Mozilla's root bundle.
///
/// The device verifier (the Kotlin side of `rustls-platform-verifier`) runs PKIX
/// validation with revocation checking and maps `CertPathValidatorException` to
/// Revoked without reading the reason. Android's RevocationChecker throws
/// "Certificate does not specify OCSP responder" for a certificate with no OCSP
/// responder, and the fallback to CRL never arrives because cleartext HTTP is
/// forbidden by default. Let's Encrypt, Google Trust Services and SSL.com stopped
/// serving OCSP in 2025, so every CA selectable on Cloudflare fails on this path.
/// The sync endpoint's certificate is not revoked (confirmed against the CRL).
/// Upstream: rustls/rustls-platform-verifier#221 (symptom), #179 (fix discussion).
///
/// The permanent upstream fix is to ship an allowlist of CRL distribution hosts in
/// the .aar manifest. Once that lands, delete this function and rustls /
/// webpki-roots from Cargo.toml and go back to `reqwest::Client::new()`. `init` and
/// the Gradle wiring stay for that.
///
/// What this gives up: custom CAs installed on the device, and revocation checking.
/// The sync endpoint is one Worker of our own, and revocation checking effectively
/// depended on OCSP inside the device verifier too, so neither is needed.
pub(crate) fn sync_tls_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // Name the same provider that reqwest 0.13's rustls feature selects.
    // `ClientConfig::builder()` panics when two providers are present.
    let provider = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth())
}

fn install() -> Result<(), jni::errors::Error> {
    crate::android_context::with_context(|env, context| {
        rustls_platform_verifier::android::init_with_env(env, context)
    })
    .unwrap_or(Err(jni::errors::Error::NullPtr(
        "android context not initialised",
    )))
}
