#!/usr/bin/env bash
# Starts/stops the NATS servers used by the e2e suite. Works with Docker Compose v2 and v1.
set -euo pipefail

cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

case "${1:-}" in
  up) "${COMPOSE[@]}" -p nats-transport-test -f docker-compose.yml up -d ;;
  down) "${COMPOSE[@]}" -p nats-transport-test -f docker-compose.yml down -v ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
