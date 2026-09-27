{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.magical-merchant;
  common = import ./module-options.nix { inherit lib pkgs; };
in
{
  options.services.magical-merchant = lib.recursiveUpdate common.options {
    desktop.enable.description = "Install the desktop app to /Applications/Nix Apps.";
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = common.packages cfg;

    system.activationScripts.postActivation.text = lib.mkAfter (
      lib.optionalString (cfg.workersUrl != "") ''
        CONSOLE_USER=$(/usr/bin/stat -f '%Su' /dev/console)
        USER_HOME=$(/usr/bin/dscl . -read /Users/"$CONSOLE_USER" NFSHomeDirectory | /usr/bin/awk '{print $2}')
        SYNC_DIR="$USER_HOME/Library/Application Support/com.magical-merchant.app"
        mkdir -p "$SYNC_DIR"
        printf '%s\n' ${lib.escapeShellArg (common.syncConfig cfg)} > "$SYNC_DIR/sync-config.json"
        chmod 444 "$SYNC_DIR/sync-config.json"
        chown "$CONSOLE_USER" "$SYNC_DIR" "$SYNC_DIR/sync-config.json"
      ''
    );
  };
}
