#!/usr/bin/env bash
# Builds the GitHub Pages site into $1 (default _site):
#   /            -> tiny redirect page to app/ (keeps the public link unchanged)
#   /sw.js       -> retires the old root-scoped service worker
#   /app/...     -> the app itself, with its own install scope
set -euo pipefail
out="${1:-_site}"
rm -rf "$out"
mkdir -p "$out/app"
cp -r index.html app.js styles.css sw.js kalorit.webmanifest lib vendor data icons "$out/app/"
cp scripts/site/index.html scripts/site/sw.js "$out/"
cp icons/icon-192.png "$out/favicon.png"
touch "$out/.nojekyll"
echo "site built in $out"
