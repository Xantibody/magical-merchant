{ pkgs }:
let
  inherit (pkgs) lib;

  # The one place Rust comes from. An override written per shell lets the
  # versions drift apart without anyone noticing
  mkRustToolchain =
    {
      extensions ? [ ],
      targets ? [ ],
    }:
    pkgs.rust-bin.stable.latest.default.override { inherit extensions targets; };

  androidRustTargets = [
    "aarch64-linux-android"
    "armv7-linux-androideabi"
    "i686-linux-android"
    "x86_64-linux-android"
  ];

  rustToolchain = mkRustToolchain {
    extensions = [
      "rust-src"
      "clippy"
      "rust-analyzer"
    ];
    targets = androidRustTargets;
  };

  # The minimum for CI. The Android cross targets, rust-analyzer and rust-src
  # are not on cache.nixos.org and build from source, adding over ten minutes
  rustToolchainCI = mkRustToolchain { extensions = [ "clippy" ]; };

  androidNdkVersion = "29.0.14206865";
  androidComposition = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ "36" ];
    buildToolsVersions = [
      "35.0.0"
      "36.0.0"
    ];
    includeNDK = true;
    ndkVersions = [ androidNdkVersion ];
    includeSources = false;
    includeSystemImages = false;
    includeEmulator = false;
  };
  androidSdk = androidComposition.androidsdk;
  androidSdkRoot = "${androidSdk}/libexec/android-sdk";

  # vitest runs in browser mode (chromium), so it needs the browser itself
  playwrightBrowsers = pkgs.playwright-driver.browsers;
  playwrightEnv = {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
  };

  linuxTauriDeps = lib.optionals pkgs.stdenv.hostPlatform.isLinux (
    with pkgs;
    [
      webkitgtk_4_1.dev
      libappindicator-gtk3.dev
      librsvg.dev
      patchelf
      pkg-config
    ]
  );
  jsToolchain = with pkgs; [
    nodejs_22
    pnpm
    oxlint
    # Formerly typescript-go; both the package and the binary were renamed tsc
    typescript
    just
  ];
  # Source comments: Vale (English style + no Japanese) and typos (spelling)
  # read .vale.ini / typos.toml at the repo root; go runs the script that
  # narrows Vale to the lines a change added. See `just comments`
  commentLint = with pkgs; [
    vale
    typos
    go
  ];

  # Dependency audits and the test runner, shared by the local shell and CI's
  # rust shell so `just rust::check` and `just rust::test` run the same everywhere.
  # All three are prebuilt on cache.nixos.org
  rustDevTools = with pkgs; [
    cargo-deny
    cargo-machete
    cargo-nextest
  ];

  # `tauri android init` assumes rustup. Nix already holds the targets, so the
  # shim turns it into a no-op
  rustupShimHook = ''
    mkdir -p "$PWD/.nix-shims"
    cat > "$PWD/.nix-shims/rustup" << 'SHIM'
    #!/usr/bin/env bash
    # Nix manages Rust targets, so rustup calls are no-ops
    if [[ "$1" == "target" && "$2" == "add" ]]; then
      echo "info: target '$3' is already installed (managed by Nix)"
      exit 0
    fi
    exec "$@"
    SHIM
    chmod +x "$PWD/.nix-shims/rustup"
    export PATH="$PWD/.nix-shims:$PATH"
  '';

  # What wrapGAppsHook3 gives the packaged app, for `just dev`. Without the
  # schemas GTK3 leaves gtk-xft-dpi at -1 on Wayland, WebKitGTK takes that as
  # the scale, and the page lays out at devicePixelRatio -1/96. Without
  # glib-networking the webview has no TLS, so the sign-in page cannot load
  linuxWebviewHook = lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
    export XDG_DATA_DIRS="${
      lib.concatMapStringsSep ":" pkgs.glib.getSchemaDataDirPath [
        pkgs.gsettings-desktop-schemas
        pkgs.gtk3
      ]
    }''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
    export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"
  '';

  androidEnv = {
    ANDROID_HOME = androidSdkRoot;
    NDK_HOME = "${androidSdkRoot}/ndk/${androidNdkVersion}";
  };

  # apply-signing.go (`just android-sign-setup`) and cargo-tauri's android subcommand
  androidToolchain = [
    rustToolchain
    androidSdk
    pkgs.cargo-tauri
    pkgs.jdk17
    pkgs.go
  ];
in
{
  default = pkgs.mkShell (
    playwrightEnv
    // androidEnv
    // {
      buildInputs =
        androidToolchain
        ++ [
          pkgs.wrangler
          pkgs.agent-browser
        ]
        ++ jsToolchain
        ++ commentLint
        ++ rustDevTools
        ++ linuxTauriDeps;
      shellHook = rustupShimHook + linuxWebviewHook;
    }
  );

  # The minimum for building the release APK. Dropping Playwright and browser
  # automation from default keeps what CI has to fetch small
  android = pkgs.mkShell (
    androidEnv
    // {
      buildInputs = androidToolchain ++ jsToolchain;
      shellHook = rustupShimHook;
    }
  );

  # CI only. default carries the Android SDK/NDK and the Rust cross targets,
  # which build from source every time and time the job out
  rust = pkgs.mkShell {
    buildInputs = [
      rustToolchainCI
      pkgs.just
    ]
    ++ rustDevTools
    ++ linuxTauriDeps;
  };

  frontend = pkgs.mkShell (playwrightEnv // { buildInputs = jsToolchain; });

  # wrangler is a devDependency in workers/package.json, so the nix one is not needed
  workers = pkgs.mkShell {
    buildInputs = jsToolchain;
  };

  # CI's comment lint: two static binaries, no toolchain
  comments = pkgs.mkShell {
    buildInputs = commentLint ++ [ pkgs.just ];
  };
}
