mod rust
mod tauri_app 'tauri-app'
mod workers

[private]
default:
  @just --list

fmt:
  nix fmt

check: rust::check tauri_app::check workers::check comments-changed

test: rust::test tauri_app::test workers::test

verify: fmt check test

# Source comments are English (Vale: no Japanese, the proper nouns, proselint)
# and spelled right (typos), over the whole tree. Red until the Japanese
# comments from before the switch are translated; CI runs comments-changed
comments:
  typos
  vale core cli workers/src tauri-app/src tauri-app/src-tauri/src

# What CI runs: typos over the tree, Vale over the lines added since `base`
# (default: where this branch left main). Uncommitted edits count; new files
# only once they are tracked
comments-changed base="":
  #!/usr/bin/env bash
  set -euo pipefail
  base="{{ base }}"
  typos
  go run scripts/comments-changed.go "${base:-$(git merge-base main HEAD)}"

# 毎日叩くのはこれだけなので root に置く。他は `just tauri_app::…` を直接呼ぶ
dev: tauri_app::dev
