{
  lib,
  stdenv,
  cargo-tauri,
  rustPlatform,
  nodejs_22,
  pnpm_10,
  pnpmConfigHook,
  fetchPnpmDeps,
  fetchurl,
  typescript-go,
  pkg-config,
}:
let
  crateApiUrl = "https://crates.io/api/v1/crates";
  crateMirrorUrl = "https://static.crates.io/crates";
in
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

  # crates.io は api/v1 の download を curl 系の User-Agent に 403 で返すように
  # なった。importCargoLock はその URL を内部で組み立てるので、Cargo.lock に
  # バイナリキャッシュ未収録の crate が 1 つ入るだけで nix ビルドだけが落ちる。
  # api/v1 のリダイレクト先である static.crates.io は同じ URL の形をそのまま
  # 受けるので、取得の一段下で向け直す。
  #
  # extraRegistries で差し替えないのは、あれが .cargo/config.toml にも
  # `[source."…crates.io-index"]` を足し、cargo が crates-io の二重定義として
  # 撥ねるため。
  cargoDeps =
    (rustPlatform.importCargoLock.override {
      fetchurl =
        args:
        fetchurl (
          args
          // {
            url = lib.replaceStrings [ crateApiUrl ] [ crateMirrorUrl ] args.url;
          }
        );
    })
      {
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
