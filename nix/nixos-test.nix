# The NixOS module on a real boot: the apps land on the PATH and the user's
# data directory gets a read-only sync-config.json, with every directory on
# the way owned by the user rather than root.
{ self }:
{
  name = "magical-merchant-nixos-module";

  nodes.machine = {
    imports = [ self.nixosModules.default ];

    users.users.alice = {
      isNormalUser = true;
      # No ~/.local yet: the module must create it as alice
      createHome = true;
    };

    services.magical-merchant = {
      enable = true;
      cli.enable = true;
      user = "alice";
      workersUrl = "https://sync.example.workers.dev";
      autoSync = true;
    };
  };

  testScript = ''
    import json

    machine.wait_for_unit("multi-user.target")

    machine.succeed("command -v magical-merchant-app")
    machine.succeed("command -v magical-merchant")

    path = "/home/alice/.local/share/com.magical-merchant.app/sync-config.json"
    config = json.loads(machine.succeed(f"su alice -c 'cat {path}'"))
    assert config == {
        "workers_url": "https://sync.example.workers.dev",
        "auto_sync": True,
        "sync_on_start": False,
    }, config

    # Read-only is what tells the app the module owns it
    machine.fail(f"su alice -c 'test -w {path}'")

    for d in ["/home/alice/.local", "/home/alice/.local/share",
              "/home/alice/.local/share/com.magical-merchant.app"]:
        owner = machine.succeed(f"stat -c %U {d}").strip()
        assert owner == "alice", f"{d} is owned by {owner}"

    # A second activation (a rebuild) leaves it as it was
    machine.succeed("/run/current-system/activate")
    machine.succeed(f"su alice -c 'cat {path}'")
  '';
}
