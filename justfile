tauri-app := "tauri-app"

# Run clippy for linting
lint:
    cargo clippy --workspace -- -D warnings

# Run formatter
format:
    cargo fmt --all

# Run formatter check (CI用)
format-check:
    cargo fmt --all --check

# Run tests
test:
    cargo test --workspace

# Run all checks (lint + format-check + test)
check: lint format-check test

# Install frontend dependencies
fe-install:
    cd {{tauri-app}} && pnpm install

# Build frontend
fe-build:
    cd {{tauri-app}} && pnpm build

# Run tauri desktop dev
dev:
    cd {{tauri-app}} && pnpm tauri dev

# Run tauri android init
android-init:
    cd {{tauri-app}} && pnpm tauri android init

# Run tauri android dev (実機 or エミュレータ)
android-dev:
    cd {{tauri-app}} && pnpm tauri android dev

# Run tauri android build (release APK)
android-build:
    cd {{tauri-app}} && pnpm tauri android build

# Full verify: rust checks + frontend build
verify: check fe-build
