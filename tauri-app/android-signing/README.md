# Android Release Signing (personal distribution)

Build a **signed release APK** for personal use and side-load it onto your own
Android device — no Google Play account required.

Why signed release (not the debug APK):

- Optimized/minified build (`isMinifyEnabled = true`)
- Installable via file transfer or cloud, not only USB
- A stable signing key means you can **reinstall over the top to update** the app

## How regeneration is handled

`src-tauri/gen/android/` is gitignored and is recreated by `tauri android init`.
So the signing setup is **not** stored there. Instead,
[`apply-signing.go`](apply-signing.go) injects the signing config into
`app/build.gradle.kts` with idempotent markers. Re-run it (via
`just android-sign-setup`, which the release recipes depend on) any time the
Gradle project is regenerated. Secrets live only in a local, gitignored
`keystore.properties`.

## One-time setup

### 1. Create a keystore (keep it forever, back it up)

```sh
mkdir -p ~/.android-keys
keytool -genkey -v -keystore ~/.android-keys/magical-merchant.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias magical-merchant
```

> ⚠️ If you lose this `.jks` or its passwords you cannot publish updates that
> overwrite the installed app — you'd have to uninstall and reinstall fresh.
> Back up the file and passwords somewhere safe.

### 2. Configure `keystore.properties`

```sh
cp android-signing/keystore.properties.example \
   src-tauri/gen/android/keystore.properties
```

Then edit `src-tauri/gen/android/keystore.properties` and fill in `storeFile`
(absolute path to the `.jks`), `storePassword`, `keyAlias`, and `keyPassword`.
This file is gitignored — do not commit it.

## Build & install

From the `tauri-app/` directory:

```sh
# Build a signed release APK (runs android-sign-setup automatically)
just android-build-release

# …or build and install onto a USB-connected device in one step
just android-install-release
```

The signed APK is written to:

```
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

To distribute without USB: copy that APK to your device (cloud, AirDrop-style
transfer, email to yourself, etc.), then open it on the device and allow
"install from unknown sources" when prompted.

## Updating the app

Bump `versionCode` (and `versionName`) in
`src-tauri/gen/android/app/tauri.properties`, rebuild, and install over the
existing app with `adb install -r …` (what `android-install-release` does). The
same signing key lets it install as an update rather than a conflicting app.

## Verifying the signature (optional)

`apksigner` ships with Android SDK build-tools:

```sh
apksigner verify --verbose --print-certs \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```
