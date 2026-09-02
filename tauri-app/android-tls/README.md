# Android TLS trust store

reqwest 0.13 dropped the CA bundle it used to compile into the binary
(`webpki-roots`) and now verifies server certificates with
[`rustls-platform-verifier`], which asks the operating system instead. On
macOS, Windows and desktop Linux that crate reaches the trust store on its own.
On Android it cannot: the store is only reachable through Java, so two things
have to be arranged before the first HTTPS request.

| Half   | Where                                               | What it does                                                     |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------- |
| Kotlin | `apply-tls.go` → `gen/android/app/build.gradle.kts` | Puts `org.rustls.platformverifier` on the app's classpath        |
| Rust   | `../src-tauri/src/android_tls.rs`                   | Hands the crate the process' `JavaVM` and the activity `Context` |

Neither half fails the build when it is missing. Without the Kotlin side the
JNI lookup finds no class; without the Rust side the verifier has no `Context`.
Either way the APK installs, the app opens, and only **sync** breaks — with a
certificate error that says nothing about the real cause.

## Currently bypassed for sync

The wiring above is in place and initialises, but the sync client does not
use it yet. Android's revocation checker throws for any certificate without
an OCSP responder, and the Kotlin half maps every such exception to
`Revoked`; Let's Encrypt, Google Trust Services and SSL.com — every CA
Cloudflare can issue from — dropped OCSP in 2025, so sync failed with
`invalid peer certificate: Revoked` on every device. Until upstream ships
its fix (an allowlist of CRL hosts in the `.aar` manifest — see
[rustls-platform-verifier#221] and [#179]), `android_tls::sync_tls_config`
builds the sync client's TLS config from `webpki-roots` instead. Remove that
function and the `rustls` / `webpki-roots` dependencies once the platform
verifier verifies the sync host again; everything else here stays as is.

[rustls-platform-verifier#221]: https://github.com/rustls/rustls-platform-verifier/issues/221
[#179]: https://github.com/rustls/rustls-platform-verifier/pull/179

## Why a patcher

`src-tauri/gen/android/` is gitignored and recreated by `tauri android init`,
so the Gradle edit cannot simply live there. `apply-tls.go` re-applies it and
runs as part of `just android-setup`, which `android-init` and the build
recipes depend on. Like `../android-signing/` and `../android-widget/`, every
inserted region is wrapped in marker comments and stripped before
re-insertion, so any number of runs yields the same file.

Two regions go into `build.gradle.kts` and one into `proguard-rules.pro`:

- a `maven { }` repository pointing at the local repository bundled inside the
  `rustls-platform-verifier-android` crate, located via `cargo metadata`
- an `implementation` dependency on the artifact found there
- a `-keep` rule, because R8 cannot see JNI usage and would otherwise strip the
  classes out of a minified release build — a failure that only shows up in the
  shipped APK

The version is read out of `cargo metadata` rather than written as
`latest.release`: the bundled repository ships a `maven-metadata-local.xml`,
not the `maven-metadata.xml` a dynamic version needs.

## Checking it

`just android-build-debug` fails at `:app:checkUniversalDebugAarMetadata` if
the repository cannot be located. That the classes actually reached the APK is
one step further out:

```sh
dexdump -f src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk \
  | grep -c platformverifier
```

[`rustls-platform-verifier`]: https://crates.io/crates/rustls-platform-verifier
