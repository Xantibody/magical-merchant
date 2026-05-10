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

# --- Dev shortcuts ---

dev: tauri_app::dev

android-init: tauri_app::android-init

android-dev: tauri_app::android-dev

android-build: tauri_app::android-build

android-build-debug: tauri_app::android-build-debug

android-install: tauri_app::android-install

build: tauri_app::build
