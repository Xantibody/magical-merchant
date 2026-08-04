{
  description = "Magical Merchant: Rust core, Tauri app, and Cloudflare Workers sync";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
      flake-utils,
      treefmt-nix,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
          config.allowUnfree = true;
          config.android_sdk.accept_license = true;
        };
        # Workaround: see nix/android-repo-fix.nix and #26
        fixedRepoFile = import ./nix/android-repo-fix.nix { inherit pkgs; };

        # Rust の入手経路はここ一箇所。shell ごとに override を書き分けると
        # バージョンが静かにずれる
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

        # CI 用の最小構成。Android クロスターゲットと rust-analyzer / rust-src は
        # cache.nixos.org に無くソースビルドになるため、含めると CI が十数分伸びる
        rustToolchainCI = mkRustToolchain { extensions = [ "clippy" ]; };

        androidNdkVersion = "29.0.14206865";
        androidComposition = pkgs.androidenv.composeAndroidPackages {
          repoJson = fixedRepoFile;
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

        # vitest が browser mode (chromium) なのでブラウザ本体が要る
        playwrightBrowsers = pkgs.playwright-driver.browsers;
        playwrightEnv = {
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
        };

        linuxTauriDeps = pkgs.lib.optionals pkgs.stdenv.isLinux (
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
          typescript-go
          just
        ];

        # `tauri android init` は rustup 前提。Nix がターゲットを持っているので no-op にする
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

        androidEnv = {
          ANDROID_HOME = androidSdkRoot;
          NDK_HOME = "${androidSdkRoot}/ndk/${androidNdkVersion}";
        };

        # apply-signing.go (`just android-sign-setup`) と cargo-tauri の android サブコマンド
        androidToolchain = [
          rustToolchain
          androidSdk
          pkgs.cargo-tauri
          pkgs.jdk17
          pkgs.go
        ];

        treefmtEval = treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
          programs.rustfmt.enable = true;
          programs.taplo.enable = true;
          programs.oxfmt.enable = true;
        };
      in
      {
        packages = rec {
          default = pkgs.callPackage ./nix/package.nix { };
          # pnpm-lock.yaml を変えると package.nix の hash が黙って腐り、
          # nix build (= macOS の配布経路) だけが後から壊れる。CI で単体で検証できるよう出す
          pnpm-deps = default.pnpmDeps;
        };
        formatter = treefmtEval.config.build.wrapper;
        checks.formatting = treefmtEval.config.build.check self;
        devShells.default = pkgs.mkShell (
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
              ++ linuxTauriDeps;
            shellHook = rustupShimHook;
          }
        );

        # リリース用 APK をビルドする最小構成。default から Playwright と
        # ブラウザ自動化を落としたぶん、CI の取得量が小さい
        devShells.android = pkgs.mkShell (
          androidEnv
          // {
            buildInputs = androidToolchain ++ jsToolchain;
            shellHook = rustupShimHook;
          }
        );

        # CI 専用の shell。default は Android SDK/NDK と Rust クロスターゲットを含み、
        # それらは毎回ソースビルドされるため CI で使うとジョブが timeout する
        devShells.rust = pkgs.mkShell {
          buildInputs = [
            rustToolchainCI
            pkgs.just
          ]
          ++ linuxTauriDeps;
        };

        devShells.frontend = pkgs.mkShell (playwrightEnv // { buildInputs = jsToolchain; });

        # wrangler は workers/package.json の devDependency なので nix 版は不要
        devShells.workers = pkgs.mkShell {
          buildInputs = jsToolchain;
        };
      }
    )
    // {
      # このフレークのパッケージを既定値として差し込む。nixpkgs には無いので
      # mkPackageOption の既定値のままでは評価に失敗する
      darwinModules.default =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/darwin-module.nix ];
          services.magical-merchant.package =
            lib.mkDefault
              self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
    };
}
