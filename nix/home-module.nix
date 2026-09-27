{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.magical-merchant;
  common = import ./module-options.nix { inherit lib pkgs; };
in
{
  options.programs.magical-merchant = common.options;

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      { home.packages = common.packages cfg; }

      # A symlink into the store, so read-only, which tells the app to hide the
      # Settings fields the module owns. force: the app writes this same file
      # when sync is set up by hand, and the module is meant to take it over
      # rather than stop the activation. The directory is where the app and the
      # CLI (dirs::data_dir) look on each platform
      (lib.mkIf (cfg.workersUrl != "") (
        let
          file = {
            text = common.syncConfig cfg + "\n";
            force = true;
          };
        in
        if pkgs.stdenv.hostPlatform.isDarwin then
          { home.file."Library/Application Support/com.magical-merchant.app/sync-config.json" = file; }
        else
          { xdg.dataFile."com.magical-merchant.app/sync-config.json" = file; }
      ))
    ]
  );
}
