#!/usr/bin/env bash
# Re-download the Material Symbols subset used by the app.
# Edit assets/fonts/symbols.txt (comma-separated, alphabetical) first.
set -euo pipefail
cd "$(dirname "$0")/.."
NAMES=$(tr -d '\n ' < assets/fonts/symbols.txt)
UA="Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36"
CSS="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400..600,0..1,0&icon_names=${NAMES}&display=block"
URL=$(curl -fsS -A "$UA" "$CSS" | grep -oE 'https://[^)]+' | head -1)
curl -fsS -o assets/fonts/symbols.woff2 "$URL"
echo "Updated assets/fonts/symbols.woff2 ($(wc -c < assets/fonts/symbols.woff2) bytes)"
