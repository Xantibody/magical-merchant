# Install

## macOS — Nix (recommended)

```sh
# Install into your Nix profile (adds /Applications/Nix Apps/Magical Merchant.app)
nix profile install github:Xantibody/magical-merchant

# …or pin a released version
nix profile install github:Xantibody/magical-merchant/v0.1.0

# Update later
nix profile upgrade magical-merchant
```

CI publishes every `main` build of the app and the CLI (aarch64-darwin) to
`https://magical-merchant.cachix.org`. The flake does not name that cache — a
substituter declared in `nixConfig` is ignored unless your user is in
`trusted-users`, which it is not under a stock install. Add it to your own Nix
configuration instead, and nothing is built locally:

```nix
nix.settings = {
  extra-substituters = [ "https://magical-merchant.cachix.org" ];
  extra-trusted-public-keys = [
    "magical-merchant.cachix.org-1:r8cvPKg3xGAINHclAor7fWiS7YK5pZ1Bxs4XjGnyvp0="
  ];
};
```

To build from a local checkout instead:

```sh
nix build .#default
open result/Applications/Magical\ Merchant.app
```

## macOS / Linux — CLI

The terminal client (`list` / `show` / `edit` / `new` / `import` / `sync`, and
the MCP server behind `mcp`) is its own package and needs none of the app's toolchain:

```sh
nix profile install github:Xantibody/magical-merchant#cli
magical-merchant list
magical-merchant sync
```

It reads the same data directory and `sync-config.json` the app uses, so
`magical-merchant sync` runs the sync the app's own button runs — there is no
Workers URL to repeat here, and both surfaces take the same `.sync.lock`, so
whichever one arrives second gives up (`busy`) instead of overwriting the
other's state.

Signing in stays in the app. The CLI reads the token the app saved (the
Keychain on macOS) and never opens a browser of its own; once that login has
expired it stops before touching the network and tells you to log in again
from the app's Settings.

## macOS — nix-darwin module

Add the flake input and enable the module in your nix-darwin configuration:

```nix
# flake.nix
{
  inputs.magical-merchant.url = "github:Xantibody/magical-merchant";

  outputs = { magical-merchant, ... }: {
    darwinConfigurations.myMac = darwin.lib.darwinSystem {
      modules = [
        magical-merchant.darwinModules.default
        {
          services.magical-merchant = {
            enable = true;
            desktop.enable = true; # the app in /Applications/Nix Apps (default)
            cli.enable = true; # `magical-merchant` on the PATH
            workersUrl = "https://your-worker.example.workers.dev"; # R2 sync URL; must not end with a trailing slash, or sync requests may become `//files`
            autoSync = true; # sync after every successful save
          };
        }
      ];
    };
  };
}
```

The module installs whichever of the desktop app and the CLI are enabled
and writes a read-only `sync-config.json` from the options above. Both
read that one file, so the app hides the Settings fields it no longer owns
and the CLI needs no configuration of its own.

Do not add `inputs.magical-merchant.inputs.nixpkgs.follows` to that input: the
packages would then be built against your `nixpkgs`, which is not what CI built,
and the binary cache above would never hit. Let the flake keep its own lock.

## macOS — manual build

```sh
# Build the .app bundle
just tauri_app::build

# Copy to Applications
cp -r "target/release/bundle/macos/Magical Merchant.app" /Applications/

# Remove Gatekeeper quarantine (unsigned app)
xattr -cr "/Applications/Magical Merchant.app"
```

## Android — signed test APK

Releases are side-loaded, not published to the Play Store. Grab the APK from
[Releases](https://github.com/Xantibody/magical-merchant/releases), allow
"install from unknown sources" on the device, and open it. Because every
release is signed with the same key, a new APK installs over the previous one
as an update.

Tagging `vX.Y.Z` (matching `version` in
`tauri-app/src-tauri/tauri.conf.json`) runs
`.github/workflows/release.yml`, which builds and attaches the APK. The
workflow needs these repository secrets:

| Secret                      | Value                                            |
| --------------------------- | ------------------------------------------------ |
| `ANDROID_KEYSTORE_BASE64`   | `base64 -i ~/.android-keys/magical-merchant.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password                                |
| `ANDROID_KEY_ALIAS`         | Key alias (e.g. `magical-merchant`)              |
| `ANDROID_KEY_PASSWORD`      | Key password                                     |

See
[`tauri-app/android-signing/README.md`](../tauri-app/android-signing/README.md)
for creating the keystore and for building locally.

## Android — home screen widgets

Three widgets ship with the APK. The Timeline capture bar (4×1) opens a sheet
over the home screen and appends straight to today's timeline through a JNI
call into `magical_merchant_core` — the app is never started. The "new note"
bar (4×1) and the recent notes list (4×2) open the app on
`magical-merchant://widget/…` deep links. Sources live in
[`tauri-app/android-widget/`](../tauri-app/android-widget/README.md) and are
injected into the generated Gradle project by `just android-setup`.
