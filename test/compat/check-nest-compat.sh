#!/usr/bin/env bash
# Compatibility of the library with several NestJS majors.
# NestJS 10, 11 and 12 are supported (SUPPORTED_MAJORS) and expected to pass every check; npm is expected to refuse
# installing the library next to any other major (NestJS 9 by default).
#   COMPAT-01 types:   library sources type-check against the NestJS version
#   COMPAT-02 load:    the compiled library (as published to npm) can be required in a project with that version
#   COMPAT-03 runtime: RPC + JetStream event work end to end (needs the e2e NATS: yarn test:e2e:infra:up)
#   COMPAT-04 install: npm installs the packed library next to a supported version and refuses (ERESOLVE) any other
#   COMPAT-05 typings: a consumer with "skipLibCheck": false type-checks against the installed library
#   COMPAT-07 nats:    npm refuses (ERESOLVE) a project whose nats is outside the peer range: no second copy of nats
#   COMPAT-08 contents: the package holds the compiled library, README, LICENSE and package.json only
# Usage: bash test/compat/check-nest-compat.sh [nest-version ...]   (needs network access for npm install)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSIONS=("$@")
[ ${#VERSIONS[@]} -eq 0 ] && VERSIONS=(9.4.3 10.4.15 11.2.7 12.1.2)
NATS_URL="${NATS_E2E_MAIN_URL:-nats://127.0.0.1:14222}"
SUPPORTED_MAJORS=(10 11 12)

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT

TS_VERSION="$(node -p "require('$ROOT/node_modules/typescript/package.json').version")"
NATS_VERSION="$(node -p "require('$ROOT/node_modules/nats/package.json').version")"
NEST_VERSION="$(node -p "require('$ROOT/node_modules/@nestjs/core/package.json').version")"
FAILED=0

# The library as it is published: compiled against the NestJS version from devDependencies
if ! node "$ROOT/node_modules/typescript/bin/tsc" -p "$ROOT/tsconfig.json" --outDir "$WORK/published" --incremental false; then
  echo "Library build failed"
  exit 1
fi

# The library as npm installs it: package.json and the compiled library packed into a tarball
mkdir -p "$WORK/package"
cp "$ROOT/package.json" "$WORK/package/"
cp -r "$WORK/published" "$WORK/package/dist"
TARBALL="$WORK/$(cd "$WORK" && npm pack ./package --silent 2>/dev/null | tail -1)"

check_install() {
  local output code
  output="$(cd "$1" && npm install --no-save --no-audit --no-fund "$TARBALL" 2>&1)"
  code=$?
  if [ "$2" = supported ] && [ $code -eq 0 ]; then
    echo "  COMPAT-04 install: OK"
    return 0
  elif [ "$2" = unsupported ] && grep -q ERESOLVE <<<"$output"; then
    echo "  COMPAT-04 install: OK (npm refuses: ERESOLVE)"
  elif [ $code -eq 0 ]; then
    echo "  COMPAT-04 install: npm installs the library next to an unsupported NestJS"
    FAILED=1
  else
    echo "  COMPAT-04 install: $(grep -m1 -E 'ERESOLVE|ERR!' <<<"$output")"
    FAILED=1
  fi
  return 1
}

check_typings() {
  printf '%s\n' "import { ClientNats, NatsContext, NatsEventPattern, ServerNats } from 'nestjs-nats-transport';" \
    "export const server = new ServerNats({ consumerName: 'compat', connection: {} });" \
    "export const client = new ClientNats({ connection: {} });" \
    "export const api = [NatsContext, NatsEventPattern];" >"$1/consumer.ts"
  local errors
  errors="$(cd "$1" && ./node_modules/.bin/tsc --noEmit --skipLibCheck false --types node consumer.ts 2>&1 |
    grep 'node_modules/nestjs-nats-transport/.*error TS')"
  if [ -z "$errors" ]; then
    echo "  COMPAT-05 typings: OK"
  else
    echo "  COMPAT-05 typings: $(wc -l <<<"$errors") errors"
    sed 's/^/      /' <<<"$errors"
    FAILED=1
  fi
}

nats_reachable() {
  node -e "
    const { hostname, port } = new URL('$NATS_URL');
    const s = require('net').connect(Number(port), hostname, () => process.exit(0));
    s.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 1000);
  "
}

for VERSION in "${VERSIONS[@]}"; do
  DIR="$WORK/nest-$VERSION"
  mkdir -p "$DIR"
  cp -r "$ROOT/src" "$ROOT/tsconfig.json" "$DIR/"
  cp -r "$WORK/published" "$DIR/lib"
  cp "$ROOT/test/compat/runtime-smoke.js" "$DIR/"
  cat >"$DIR/package.json" <<EOF
{
  "name": "nest-compat-$VERSION",
  "private": true,
  "dependencies": {
    "@nestjs/common": "$VERSION",
    "@nestjs/core": "$VERSION",
    "@nestjs/microservices": "$VERSION",
    "@types/node": "20.14.4",
    "nats": "$NATS_VERSION",
    "reflect-metadata": "^0.1.12 || ^0.2.0",
    "rxjs": "7.8.2",
    "typescript": "$TS_VERSION"
  }
}
EOF

  echo "NestJS $VERSION"
  if ! (cd "$DIR" && npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1); then
    echo "  npm install failed"
    FAILED=1
    continue
  fi

  if [[ " ${SUPPORTED_MAJORS[*]} " != *" ${VERSION%%.*} "* ]]; then
    echo "  COMPAT-01…03:      skipped (NestJS ${VERSION%%.*} is not supported)"
    check_install "$DIR" unsupported
    continue
  fi

  OUTPUT="$(cd "$DIR" && ./node_modules/.bin/tsc --noEmit -p . 2>&1)"
  COUNT="$(grep -c 'error TS' <<<"$OUTPUT")"
  if [ "$COUNT" -eq 0 ]; then
    echo "  COMPAT-01 types:   OK"
  else
    echo "  COMPAT-01 types:   $COUNT errors"
    grep 'error TS' <<<"$OUTPUT" | sed 's/^/      /'
    FAILED=1
  fi

  LOAD="$(cd "$DIR" && node -e "require('reflect-metadata'); require('./lib'); console.log('OK')" 2>&1 | grep -E '^OK$|Error' | head -1)"
  echo "  COMPAT-02 load:    $LOAD"
  [ "$LOAD" = "OK" ] || FAILED=1

  if [ "$LOAD" != "OK" ]; then
    echo "  COMPAT-03 runtime: skipped (library does not load)"
  elif ! nats_reachable; then
    echo "  COMPAT-03 runtime: skipped (NATS is not reachable at $NATS_URL)"
  else
    RUNTIME="$(cd "$DIR" && timeout 30 node runtime-smoke.js "$DIR/lib" "$NATS_URL" 2>&1 | grep -E '^OK$|^FAILED|^unexpected' | head -1)"
    echo "  COMPAT-03 runtime: ${RUNTIME:-FAILED: no output}"
    [ "$RUNTIME" = "OK" ] || FAILED=1
  fi
  check_install "$DIR" supported && check_typings "$DIR"
done

# The next major cannot be installed yet: npm will refuse it only if no @nestjs/* peer range is open-ended
NEXT_MAJOR="$((SUPPORTED_MAJORS[-1] + 1)).0.0"
OPEN_RANGES="$(node -e "
  const semver = require('$(npm root -g)/npm/node_modules/semver');
  const peers = require('$ROOT/package.json').peerDependencies;
  const nest = Object.keys(peers).filter(name => name.startsWith('@nestjs/'));
  console.log(nest.filter(name => semver.satisfies('$NEXT_MAJOR', peers[name])).join(', '));
")"
echo "NestJS $NEXT_MAJOR (not released yet)"
if [ -z "$OPEN_RANGES" ]; then
  echo "  COMPAT-04 install: OK (outside the peer ranges)"
else
  echo "  COMPAT-04 install: allowed by the peer ranges of $OPEN_RANGES"
  FAILED=1
fi

echo "Package"
# nats 2.28.2 is outside the peer range: with nats in dependencies npm would install a second copy of nats
mkdir -p "$WORK/other-nats"
cat >"$WORK/other-nats/package.json" <<EOF
{
  "name": "other-nats",
  "private": true,
  "dependencies": {
    "@nestjs/common": "$NEST_VERSION",
    "@nestjs/core": "$NEST_VERSION",
    "@nestjs/microservices": "$NEST_VERSION",
    "nats": "2.28.2",
    "reflect-metadata": "^0.1.12 || ^0.2.0",
    "rxjs": "7.8.2"
  }
}
EOF
INSTALL="$(cd "$WORK/other-nats" && npm install --dry-run --no-save --no-audit --no-fund "$TARBALL" 2>&1)"
if grep -q ERESOLVE <<<"$INSTALL"; then
  echo "  COMPAT-07 nats:    OK (npm refuses nats 2.28.2: ERESOLVE)"
else
  echo "  COMPAT-07 nats:    npm installs the library next to nats 2.28.2 (a second copy of nats)"
  FAILED=1
fi

# What npm publishes from the working tree after a build: .npmignore keeps out the sources, tests and CI
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude test/.build "$ROOT/" "$WORK/repo/"
cp -r "$WORK/published" "$WORK/repo/dist"
CONTENTS="$(cd "$WORK/repo" && npm pack --dry-run --json 2>/dev/null | node -e "
  const files = JSON.parse(require('fs').readFileSync(0, 'utf8'))[0].files.map(file => file.path);
  const allowed = ['README.md', 'LICENSE', 'package.json'];
  const extra = files.filter(file => !file.startsWith('dist/') && !allowed.includes(file));
  const missing = ['dist/index.js', 'dist/index.d.ts'].filter(file => !files.includes(file));
  console.log([...extra.map(file => 'extra ' + file), ...missing.map(file => 'missing ' + file)].join(', '));
")"
if [ -z "$CONTENTS" ]; then
  echo "  COMPAT-08 contents: OK"
else
  echo "  COMPAT-08 contents: $CONTENTS"
  FAILED=1
fi

exit $FAILED
