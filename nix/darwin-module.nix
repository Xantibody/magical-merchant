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
    enable = lib.mkEnableOption "Magical Merchant";

    package = lib.mkPackageOption pkgs "magical-merchant" { };

    # デスクトップと CLI は別々に入れられる。サーバー的な Mac には CLI だけ、
    # 普段使いの Mac には両方、という分かれ方をする
    desktop.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install the desktop app to /Applications/Nix Apps.";
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
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages =
      lib.optional cfg.desktop.enable cfg.package ++ lib.optional cfg.cli.enable cfg.cli.package;

    # sync-config.json はアプリと CLI が同じ場所から読む共通の設定。
    # module が書くと、どちらを入れても同じ接続先になる
    system.activationScripts.postActivation.text = lib.mkAfter (
      lib.optionalString (cfg.workersUrl != "") ''
        CONSOLE_USER=$(/usr/bin/stat -f '%Su' /dev/console)
        USER_HOME=$(/usr/bin/dscl . -read /Users/"$CONSOLE_USER" NFSHomeDirectory | /usr/bin/awk '{print $2}')
        SYNC_DIR="$USER_HOME/Library/Application Support/com.magical-merchant.app"
        mkdir -p "$SYNC_DIR"
        printf '%s\n' ${
          lib.escapeShellArg (
            builtins.toJSON {
              workers_url = cfg.workersUrl;
              auto_sync = cfg.autoSync;
            }
          )
        } > "$SYNC_DIR/sync-config.json"
        chmod 444 "$SYNC_DIR/sync-config.json"
        chown "$CONSOLE_USER" "$SYNC_DIR" "$SYNC_DIR/sync-config.json"
      ''
    );
  };
}
