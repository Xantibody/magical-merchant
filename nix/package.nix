{
  lib,
  stdenv,
  cargo-tauri,
  rustPlatform,
  nodejs_22,
  pnpm_10,
  pnpmConfigHook,
  fetchPnpmDeps,
  typescript-go,
  pkg-config,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "magical-merchant";
  version = "0.2.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../core
      # mcp-cli included for workspace resolution only
      ../mcp-cli/Cargo.toml
      ../mcp-cli/src
      ../tauri-app/src-tauri
      ../tauri-app/src
      ../tauri-app/package.json
      ../tauri-app/pnpm-lock.yaml
      ../tauri-app/index.html
      ../tauri-app/vite.config.ts
      ../tauri-app/tsconfig.json
    ];
  };

  cargoDeps = rustPlatform.importCargoLock {
    lockFile = ../Cargo.lock;
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    sourceRoot = "${finalAttrs.src.name}/tauri-app";
    fetcherVersion = 3;
    hash = "sha256-EKwiJEqV2Cnecn6TKq5q7OJxu7ujpmJfCqk9NsYfcig=";
  };

  nativeBuildInputs = [
    cargo-tauri.hook
    rustPlatform.cargoSetupHook
    nodejs_22
    pnpm_10
    pnpmConfigHook
    typescript-go
    pkg-config
  ];

  buildAndTestSubdir = "tauri-app/src-tauri";
  pnpmRoot = "tauri-app";

  env.tauriBundleType = "app";

  # The sandbox has neither codesign nor xattr, and a Developer ID signature
  # cannot exist in a nix build anyway; the linker's ad-hoc one is enough
  tauriBuildFlags = [ "--no-sign" ];

  meta = {
    description = "Minimal note-taking desktop app";
    inherit (cargo-tauri.hook.meta) platforms;
  };
})
