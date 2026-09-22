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

# --- サンドボックス ---
#
# 見本のデータ(fixtures/)を写した箱で本物のアプリを動かす。自分の記録を
# 触らずに新機能を触れる場所で、同期の設定を写さないので R2 にも出ない。
# アプリが箱を向けるのは debug ビルドだけ(`app_base_dir`)。
#
# 中身は `cargo xtask` にある。端末ごとのデータの置き場もアプリの識別子も
# 既に Rust 側に答えがあり、ここで書き直すと 3 つ目の答えが増える。

# 見本のデータでアプリを起動する(箱が無ければ作る)
sandbox:
  cargo xtask sandbox ensure
  MAGICAL_MERCHANT_DATA_DIR="$(cargo xtask sandbox path)" just tauri_app::dev

# fixtures/ から箱を作り直す。箱に書き足したものは消える
sandbox-seed:
  cargo xtask sandbox seed

# 自分のテンプレも箱に足す。本番からは読むだけで、写し先は gitignore の中
sandbox-seed-mine:
  cargo xtask sandbox seed --mine

# 箱ごと捨てる。fixtures/ は動かない
sandbox-reset:
  cargo xtask sandbox reset
