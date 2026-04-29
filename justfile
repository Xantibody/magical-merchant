mod rust
mod tauri_app 'tauri-app'

[private]
default:
  @just --list

fmt:
  nix fmt

check: rust::check tauri_app::check

test: rust::test tauri_app::test

verify: fmt check test

# --- Dev shortcuts ---

dev: tauri_app::dev

android-init: tauri_app::android-init

android-dev: tauri_app::android-dev

android-build: tauri_app::android-build

android-build-debug: tauri_app::android-build-debug

android-install: tauri_app::android-install

build: tauri_app::build
