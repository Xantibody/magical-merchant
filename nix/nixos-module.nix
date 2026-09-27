{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.magical-merchant;
  common = import ./module-options.nix { inherit lib pkgs; };
  etcPath = "magical-merchant/sync-config.json";
  # Guarded so a missing user reaches the assertion below, not an eval error
  dataDir =
    lib.optionalString (cfg.user != null)
      "${config.users.users.${cfg.user}.home}/.local/share/com.magical-merchant.app";
in
{
  options.services.magical-merchant = common.options // {
    user = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "alice";
      description = ''
        The user whose data directory gets sync-config.json. Needed only when
        workersUrl is set; the app and the CLI look for it under that user's
        ~/.local/share/com.magical-merchant.app.
      '';
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      { environment.systemPackages = common.packages cfg; }

      (lib.mkIf (cfg.workersUrl != "") {
        assertions = [
          {
            assertion = cfg.user != null;
            message = "services.magical-merchant.user must be set when workersUrl is.";
          }
        ];

        # The file lives in /etc, rooted by the system generation, and the
        # user's copy is a symlink to it: a store path linked straight from
        # $HOME would be garbage-collected. Read-only either way, which tells
        # the app to hide the Settings fields the module owns
        environment.etc.${etcPath}.text = common.syncConfig cfg + "\n";

        # Created as the user, not through tmpfiles: tmpfiles would make any
        # missing ~/.local or ~/.local/share owned by root
        system.activationScripts.magical-merchant = {
          deps = [ "users" ];
          text = ''
            ${pkgs.util-linux}/bin/runuser -u ${lib.escapeShellArg cfg.user} -- \
              ${pkgs.coreutils}/bin/mkdir -p ${lib.escapeShellArg dataDir}
            ${pkgs.util-linux}/bin/runuser -u ${lib.escapeShellArg cfg.user} -- \
              ${pkgs.coreutils}/bin/ln -sfn /etc/${etcPath} ${lib.escapeShellArg "${dataDir}/sync-config.json"}
          '';
        };
      })
    ]
  );
}
