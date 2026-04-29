{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.magical-merchant;
in
{
  options.services.magical-merchant = {
    enable = lib.mkEnableOption "Magical Merchant app";

    package = lib.mkPackageOption pkgs "magical-merchant" { };

    workersUrl = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare Workers URL for R2 sync.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    system.activationScripts.postUserActivation.text = lib.mkAfter (
      lib.optionalString (cfg.workersUrl != "") ''
        SYNC_DIR="$HOME/Library/Application Support/com.magical-merchant.app"
        mkdir -p "$SYNC_DIR"
        printf '%s\n' ${
          lib.escapeShellArg (builtins.toJSON { workers_url = cfg.workersUrl; })
        } > "$SYNC_DIR/sync-config.json"
      ''
    );
  };
}
