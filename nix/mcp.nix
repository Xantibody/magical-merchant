# MCP サーバーだけのパッケージ。default(Tauri アプリ)から切り出すのは、
# AI クライアントの設定に `nix run github:Xantibody/magical-merchant#mcp` と
# 書けるようにするため。アプリ本体を建てる pnpm と Tauri のツールチェーンを、
# stdio で JSON を返すだけのバイナリのために取り寄せたくない。
{
  lib,
  rustPlatform,
  fetchurl,
}:
let
  crateApiUrl = "https://crates.io/api/v1/crates";
  crateMirrorUrl = "https://static.crates.io/crates";
  cargoToml = lib.importTOML ../mcp-cli/Cargo.toml;
  cargoFlags = [
    "-p"
    "magical-merchant-mcp-cli"
  ];
in
rustPlatform.buildRustPackage {
  pname = "magical-merchant-mcp";
  inherit (cargoToml.package) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../core
      ../mcp-cli
      # ワークスペースの解決にだけ要る。ビルドはしない
      ../tauri-app/src-tauri/Cargo.toml
      ../tauri-app/src-tauri/src
      ../tauri-app/src-tauri/build.rs
    ];
  };

  # package.nix と同じ理由(crates.io の api/v1 が curl 系 UA を 403 で返す)
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

  cargoBuildFlags = cargoFlags;
  cargoTestFlags = cargoFlags;

  meta = {
    description = "Read-only MCP server for a Magical Merchant journal";
    mainProgram = "magical-merchant-mcp-cli";
  };
}
