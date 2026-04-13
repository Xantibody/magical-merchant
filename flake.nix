{
  description = "Rust development environment";

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
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [
            "rust-src"
            "clippy"
            "rust-analyzer"
          ];
          targets = [
            "aarch64-linux-android"
            "armv7-linux-androideabi"
            "i686-linux-android"
            "x86_64-linux-android"
          ];
        };
        treefmtEval = treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
          programs.rustfmt.enable = true;
          programs.taplo.enable = true;
          programs.oxfmt.enable = true;
        };
        androidComposition = pkgs.androidenv.composeAndroidPackages {
          platformVersions = [ "36" ];
          buildToolsVersions = [
            "35.0.0"
            "36.0.0"
          ];
          includeNDK = true;
          ndkVersions = [ "29.0.14206865" ];
          includeSources = false;
          includeSystemImages = false;
          includeEmulator = false;
        };
        androidSdk = androidComposition.androidsdk;
      in
      {
        formatter = treefmtEval.config.build.wrapper;
        checks.formatting = treefmtEval.config.build.check;
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            rustToolchain
            just
            nodejs_22
            pnpm
            cargo-tauri
            jdk17
            androidSdk
            oxlint
            typescript-go
          ];
          ANDROID_HOME = "${androidSdk}/libexec/android-sdk";
          NDK_HOME = "${androidSdk}/libexec/android-sdk/ndk/29.0.14206865";
          shellHook = ''
            # Create a rustup shim that no-ops for tauri android init
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
        };
      }
    );
}
