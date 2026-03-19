# Run clippy for linting
lint:
    cargo clippy

# Run formatter
format:
    cargo fmt

# Run formatter check (CI用)
format-check:
    cargo fmt --check

# Run all checks (lint + format-check)
check: lint format-check
