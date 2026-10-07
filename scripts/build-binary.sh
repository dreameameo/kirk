#!/bin/sh
# Builds ./dist/kerk, a single executable (Node SEA) with the dashboard embedded.
# Needs Node >= 22 and network access once (npx fetches postject). Builds for the OS you run it on.
set -e
cd "$(dirname "$0")/.."
mkdir -p dist
node --experimental-sea-config sea-config.json
cp "$(command -v node)" dist/kerk
FUSE=NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if [ "$(uname)" = "Darwin" ]; then
  codesign --remove-signature dist/kerk
  npx --yes postject dist/kerk NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse $FUSE --macho-segment-name NODE_SEA
  codesign --sign - dist/kerk
else
  npx --yes postject dist/kerk NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse $FUSE
fi
echo "built dist/kerk  ->  ./dist/kerk /path/to/config.json"
