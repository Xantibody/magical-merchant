# The options the nix-darwin, NixOS and home-manager modules share, and the
# sync-config.json they all write. One definition, so a new sync setting
# cannot reach one platform and miss the others.
{ lib, pkgs }:
{
  options = {
    enable = lib.mkEnableOption "Magical Merchant";

    package = lib.mkPackageOption pkgs "magical-merchant" { };

    # The desktop app and the CLI install separately: a server-like machine
    # takes only the CLI, an everyday one both
    desktop.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install the desktop app.";
    };

    cli = {
      enable = lib.mkEnableOption "the magical-merchant CLI (list, edit, mcp)";
      package = lib.mkPackageOption pkgs "magical-merchant-cli" { };
    };

    workersUrl = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare Workers URL for R2 sync.";
    };

    autoSync = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Sync automatically after each successful save.";
    };

    syncOnStart = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Sync when the app starts or comes back to the foreground.";
    };
  };

  # sync-config.json is the one file the app and the CLI both read their sync
  # settings from, so writing it here points both at the same Worker. A
  # read-only file also tells the app to hide the Settings fields it owns
  syncConfig =
    cfg:
    builtins.toJSON {
      workers_url = cfg.workersUrl;
      auto_sync = cfg.autoSync;
      sync_on_start = cfg.syncOnStart;
    };

  packages =
    cfg: lib.optional cfg.desktop.enable cfg.package ++ lib.optional cfg.cli.enable cfg.cli.package;
}
