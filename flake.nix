{
  description = "Magical Merchant: Rust core, Tauri app, and Cloudflare Workers sync";

  # AIDEV-NOTE: no cachix in nixConfig. No devShell needs it, and an untrusted installing user ignores it anyway (docs/install.md)
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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
      treefmt-nix,
    }:
    let
      # No x86_64-darwin: nixpkgs 26.11 dropped it, so merely listing it makes
      # evaluation throw. Neither CI (ubuntu / macos-latest) nor distribution
      # runs there
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      eachSystem =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
              overlays = [ (import rust-overlay) ];
              config.allowUnfree = true;
              config.android_sdk.accept_license = true;
            }
          )
        );
      treefmtFor = pkgs: treefmt-nix.lib.evalModule pkgs ./nix/treefmt.nix;
    in
    {
      packages = eachSystem (pkgs: rec {
        default = pkgs.callPackage ./nix/package.nix { };
        # Changing pnpm-lock.yaml silently rots the hash in package.nix, and only
        # nix build (the macOS distribution path) breaks, later. Exposed on its
        # own so CI can check it alone
        pnpm-deps = default.pnpmDeps;
        # One binary for listing, $EDITOR editing and the MCP server from a
        # terminal. It needs none of the app's toolchain
        cli = pkgs.callPackage ./nix/cli.nix { };
        # The entry point AI clients start with
        # `nix run github:Xantibody/magical-merchant#mcp`. A thin skin that calls
        # `magical-merchant mcp` instead of building cli again
        mcp = pkgs.writeShellScriptBin "magical-merchant-mcp" ''
          exec "${cli}/bin/magical-merchant" mcp "$@"
        '';
      });

      # `nix run github:Xantibody/magical-merchant`. On macOS the binary lives
      # inside the .app, where `nix run`'s bin/ lookup does not reach
      apps = eachSystem (
        pkgs:
        let
          app = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        in
        {
          default = {
            type = "app";
            program =
              if pkgs.stdenv.hostPlatform.isDarwin then
                "${app}/Applications/Magical Merchant.app/Contents/MacOS/${app.meta.mainProgram}"
              else
                pkgs.lib.getExe app;
            meta.description = app.meta.description;
          };
        }
      );

      formatter = eachSystem (pkgs: (treefmtFor pkgs).config.build.wrapper);
      checks = eachSystem (pkgs: {
        formatting = (treefmtFor pkgs).config.build.check self;
      });

      devShells = eachSystem (pkgs: import ./nix/devshells.nix { inherit pkgs; });

      # Plugs this flake's packages in as the defaults. nixpkgs has no such
      # package, so mkPackageOption's own default fails to evaluate
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
