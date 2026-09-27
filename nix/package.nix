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
  typescript,
  pkg-config,
  wrapGAppsHook3,
  webkitgtk_4_1,
  gtk3,
  libsoup_3,
  glib-networking,
}:
let
  crateApiUrl = "https://crates.io/api/v1/crates";
  crateMirrorUrl = "https://static.crates.io/crates";
in
stdenv.mkDerivation (finalAttrs: {
  pname = "magical-merchant";
  # tauri.conf.json is the one source; release.yml checks the tag against it too
  version = (lib.importJSON ../tauri-app/src-tauri/tauri.conf.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../core
      # cli and xtask included for workspace resolution only
      ../cli/Cargo.toml
      ../cli/src
      ../xtask
      ../tauri-app/src-tauri
      ../tauri-app/src
      ../tauri-app/package.json
      ../tauri-app/pnpm-lock.yaml
      ../tauri-app/index.html
      ../tauri-app/vite.config.ts
      ../tauri-app/tsconfig.json
    ];
  };

  # crates.io started answering api/v1 downloads from curl-like User-Agents with
  # 403. importCargoLock builds that URL internally, so a single crate missing
  # from the binary cache is enough to break only the nix build. static.crates.io,
  # where api/v1 redirects, accepts the same URL shape, so the fetch is pointed
  # there one level down.
  #
  # Not extraRegistries: it also adds `[source."…crates.io-index"]` to
  # .cargo/config.toml, and cargo rejects that as crates-io defined twice.
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
    hash = "sha256-RBdGCngXGgVH+NpNXjWyomnMqjqMiYk4yGTiEaV6kh4=";
  };

  nativeBuildInputs = [
    cargo-tauri.hook
    rustPlatform.cargoSetupHook
    nodejs_22
    pnpm_10
    pnpmConfigHook
    typescript
    pkg-config
  ]
  # Bakes the GSettings schemas and GIO modules into the launcher. Without them
  # WebKitGTK lays the page out at a negative devicePixelRatio and has no TLS
  ++ lib.optionals stdenv.hostPlatform.isLinux [ wrapGAppsHook3 ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    webkitgtk_4_1
    gtk3
    libsoup_3
    glib-networking
  ];

  buildAndTestSubdir = "tauri-app/src-tauri";
  pnpmRoot = "tauri-app";

  # The bundle type is the hook's per-platform default: an .app on macOS, and on
  # Linux a .deb whose usr/ tree (binary, .desktop with the deep-link scheme,
  # icons) becomes $out

  # The bundler lists the scheme in MimeType but leaves %u out of Exec, so a
  # clicked magical-merchant:// link would start the app without the URL the
  # deep-link plugin reads from argv
  postInstall = lib.optionalString stdenv.hostPlatform.isLinux ''
    substituteInPlace "$out/share/applications/Magical Merchant.desktop" \
      --replace-fail "Exec=magical-merchant-app" "Exec=magical-merchant-app %u"
  '';

  # The sandbox has neither codesign nor xattr, and a Developer ID signature
  # cannot exist in a nix build anyway; the linker's ad-hoc one is enough
  tauriBuildFlags = [ "--no-sign" ];

  meta = {
    description = "Minimal note-taking desktop app";
    mainProgram = "magical-merchant-app";
    inherit (cargo-tauri.hook.meta) platforms;
  };
})
