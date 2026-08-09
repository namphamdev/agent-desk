#!/usr/bin/env bash
# Developer entry point for Comet.
#
#   scripts/dev.sh run       # build and run the real Codex engine + headed app
#   scripts/dev.sh watch     # rebuild and restart on source changes
#   scripts/dev.sh demo      # run the seeded visual demo
#   scripts/dev.sh check     # compile the workspace
#   scripts/dev.sh test      # run workspace tests
#   scripts/dev.sh fmt       # format the workspace
#   scripts/dev.sh lint      # run clippy

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${COMET_DEV_IPC_PORT:-27922}"
TOKEN="${COMET_EDGE_TOKEN:-dev@dev-org}"
HARNESS="${COMET_HARNESS:-codex}"
DAEMON_DIR="${COMET_DEV_DATA_DIR:-/tmp/comet-dev-daemon}"
UI_DIR="${COMET_DEV_UI_DIR:-/tmp/comet-dev-ui}"
LOG_LEVEL="${RUST_LOG:-info}"

usage() {
  sed -n '3,10p' "$0"
}

build() {
  (cd "$ROOT" && cargo build -q -p comet)
}

run() {
  build

  echo "▸ starting local $HARNESS engine on :$PORT"
  COMET_DATA_DIR="$DAEMON_DIR" COMET_IPC_PORT="$PORT" \
    COMET_EDGE_TOKEN="$TOKEN" COMET_HARNESS="$HARNESS" RUST_LOG="$LOG_LEVEL" \
    "$ROOT/target/debug/agent-deski" headless &
  local daemon_pid=$!

  cleanup() {
    kill "$daemon_pid" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  for _ in $(seq 1 40); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      exec 3>&-
      break
    fi
    sleep 0.25
  done

  echo "▸ opening Comet"
  COMET_DATA_DIR="$UI_DIR" COMET_IPC_PORT="$PORT" \
    COMET_EDGE_TOKEN="$TOKEN" RUST_LOG="$LOG_LEVEL" \
    "$ROOT/target/debug/agent-deski"
}

watch() {
  if ! command -v cargo-watch >/dev/null 2>&1; then
    echo "cargo-watch is required for '$0 watch'." >&2
    echo "Install it with: cargo install cargo-watch" >&2
    exit 1
  fi

  exec cargo watch -s "$ROOT/scripts/dev.sh run"
}

cd "$ROOT"
case "${1:-run}" in
  run) run ;;
  watch) watch ;;
  demo) shift; exec "$ROOT/scripts/dev-demo.sh" "$@" ;;
  build|check) build ;;
  test) cargo test --workspace ;;
  fmt) cargo fmt --all ;;
  lint) cargo clippy --workspace --all-targets --all-features ;;
  -h|--help|help) usage ;;
  *) echo "Unknown command: $1" >&2; usage >&2; exit 2 ;;
esac
