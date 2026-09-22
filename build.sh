#!/usr/bin/env bash
#
# Package this extension as an unsigned XPI at dist/<gecko-id>.xpi.
#
# The archive is built from the repo root so manifest.json sits at the top level
# of the zip, which is what Gecko requires. The filename must be the extension's
# gecko id for a profile drop-in install to be recognised.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

read -r ID VERSION <<<"$(python3 -c '
import json
m = json.load(open("manifest.json"))
print(m["browser_specific_settings"]["gecko"]["id"], m["version"])
')"

OUT="dist/$ID.xpi"

rm -rf dist
mkdir -p dist

zip -r -FS -q "$OUT" . \
  -x 'dist/*' '.git/*' '.github/*' '.claude/*' '.vscode/*' '.idea/*' \
     'web-ext-artifacts/*' 'node_modules/*' '*.DS_Store' '*.swp' \
     '.gitignore' 'build.sh' 'test.js' '*.md' 'LICENSE'

echo "Built $OUT ($ID v$VERSION)"
