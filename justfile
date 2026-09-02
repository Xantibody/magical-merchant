mod rust
mod tauri_app 'tauri-app'
mod workers

[private]
default:
  @just --list

fmt:
  nix fmt

check: rust::check tauri_app::check workers::check

test: rust::test tauri_app::test workers::test

verify: fmt check test

# 毎日叩くのはこれだけなので root に置く。他は `just tauri_app::…` を直接呼ぶ
dev: tauri_app::dev
