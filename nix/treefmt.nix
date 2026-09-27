{
  projectRootFile = "flake.nix";
  # fixtures/ is sample data that only means something in exactly the shape the
  # app wrote it; it is not source. A formatter puts a blank line after the
  # frontmatter and breaks the rule that the body's first line is the title
  # (every_note_body_opens_with_its_title in core/tests/fixtures.rs)
  settings.global.excludes = [ "fixtures/**" ];
  programs.nixfmt.enable = true;
  programs.rustfmt.enable = true;
  programs.taplo.enable = true;
  programs.oxfmt.enable = true;
}
