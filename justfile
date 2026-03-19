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
    cd tauri-app && pnpm install

# Build frontend
fe-build:
    cd tauri-app && pnpm build

# Run tauri dev
dev:
    cd tauri-app && pnpm tauri dev
