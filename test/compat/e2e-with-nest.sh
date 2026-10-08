#!/usr/bin/env bash
# COMPAT-06: the e2e suite with another NestJS version. The library and the tests are copied to a temporary directory
# whose node_modules link to this repository's packages, except @nestjs/*, rxjs and reflect-metadata installed for that
# version. Needs the e2e NATS (yarn test:e2e:infra:up) and network access for npm install.
# Usage: bash test/compat/e2e-with-nest.sh <nest-version> [jest options]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:?usage: e2e-with-nest.sh <nest-version> [jest options]}"
shift

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
mkdir -p "$WORK/nest" "$WORK/repo/node_modules"

cat >"$WORK/nest/package.json" <<JSON
{
  "name": "nest-e2e-$VERSION",
  "private": true,
  "dependencies": {
    "@nestjs/common": "$VERSION",
    "@nestjs/core": "$VERSION",
    "@nestjs/microservices": "$VERSION",
    "reflect-metadata": "^0.1.12 || ^0.2.0",
    "rxjs": "7.8.2"
  }
}
JSON
(cd "$WORK/nest" && npm install --no-audit --no-fund --loglevel=error >/dev/null)

cp -r "$ROOT/src" "$ROOT/tsconfig.json" "$ROOT/package.json" "$WORK/repo/"
mkdir -p "$WORK/repo/test"
cp -r "$ROOT"/test/* "$WORK/repo/test/" # the glob skips the compiled scenarios in test/.build
for package in "$ROOT"/node_modules/* "$ROOT"/node_modules/.bin; do
  name="$(basename "$package")"
  case "$name" in
    @nestjs | rxjs | reflect-metadata) ln -s "$WORK/nest/node_modules/$name" "$WORK/repo/node_modules/" ;;
    *) ln -s "$package" "$WORK/repo/node_modules/" ;;
  esac
done

echo "e2e suite with NestJS $VERSION"
cd "$WORK/repo" && node node_modules/jest/bin/jest.js --config test/jest-e2e.config.js --runInBand "$@"
