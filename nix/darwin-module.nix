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

    environment.etc = lib.mkIf (cfg.workersUrl != "") {
      "magical-merchant/sync-config.json".text = builtins.toJSON {
        workers_url = cfg.workersUrl;
      };
    };
  };
}
