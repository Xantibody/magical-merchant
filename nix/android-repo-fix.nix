# Workaround: platform-tools v37.0.0 hash mismatch on macOS.
# Google rebuilt the zip at the same URL, changing the hash.
# See: https://github.com/Xantibody/magical-merchant/issues/26
# Remove this file once nixpkgs upstream updates the hash.
{ pkgs }:
let
  originalRepoJson = builtins.fromJSON (
    builtins.readFile "${pkgs.path}/pkgs/development/mobile/androidenv/repo.json"
  );
  fixedRepoJson = originalRepoJson // {
    packages = originalRepoJson.packages // {
      platform-tools = originalRepoJson.packages.platform-tools // {
        "37.0.0" = originalRepoJson.packages.platform-tools."37.0.0" // {
          archives = map (
            archive:
            if archive.os == "macosx" then
              archive // { sha1 = "8c4c926d0ca192376b2a04b0318484724319e67c"; }
            else
              archive
          ) originalRepoJson.packages.platform-tools."37.0.0".archives;
        };
      };
    };
  };
in
pkgs.writeText "repo.json" (builtins.toJSON fixedRepoJson)
