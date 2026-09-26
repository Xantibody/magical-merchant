{
  description = "Magical Merchant: Rust core, Tauri app, and Cloudflare Workers sync";

  # AIDEV-NOTE: cachix は nixConfig で名乗らない。devShell に取る物は無く、install 先も untrusted なら無視される (docs/install.md)
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
    # 既定の 4 システムから x86_64-darwin を外す。nixpkgs 26.11 がサポートを落としたので
    # 並べるだけで評価が throw する。CI (ubuntu / macos-latest) も配布もそこには無い
    flake-utils.lib.eachSystem [ "aarch64-darwin" "x86_64-linux" "aarch64-linux" ] (
      system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
          config.allowUnfree = true;
          config.android_sdk.accept_license = true;
        };

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
          # 旧 typescript-go。パッケージも実行ファイルも tsc に改名された
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
          # fixtures/ はアプリが書いたままの姿でなければ意味がない見本データで、
          # ソースではない。整形器に通すと frontmatter の直後に空行が入り、
          # 「本文の 1 行目がタイトル」という約束が崩れる
          # (core/tests/fixtures.rs の every_note_body_opens_with_its_title)。
          settings.global.excludes = [ "fixtures/**" ];
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
          # ターミナルから一覧・$EDITOR 編集・MCP サーバーを担う 1 バイナリ。
          # アプリ本体のツールチェーンは要らない
          cli = pkgs.callPackage ./nix/cli.nix { };
          # AI クライアントから `nix run github:Xantibody/magical-merchant#mcp` で
          # 起動する入口。cli を建て直さず、`magical-merchant mcp` を呼ぶだけの薄い皮
          mcp = pkgs.writeShellScriptBin "magical-merchant-mcp" ''
            exec "${cli}/bin/magical-merchant" mcp "$@"
          '';
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
              ++ commentLint
              ++ rustDevTools
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
          ++ rustDevTools
          ++ linuxTauriDeps;
        };

        devShells.frontend = pkgs.mkShell (playwrightEnv // { buildInputs = jsToolchain; });

        # wrangler は workers/package.json の devDependency なので nix 版は不要
        devShells.workers = pkgs.mkShell {
          buildInputs = jsToolchain;
        };

        # CI's comment lint: two static binaries, no toolchain
        devShells.comments = pkgs.mkShell {
          buildInputs = commentLint ++ [ pkgs.just ];
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
          services.magical-merchant.cli.package =
            lib.mkDefault
              self.packages.${pkgs.stdenv.hostPlatform.system}.cli;
        };
    };
}
