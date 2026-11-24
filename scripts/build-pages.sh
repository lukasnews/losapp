#!/bin/sh
# Erzeugt index.html (GitHub Pages) aus artifact/losfee.html
set -e
cd "$(dirname "$0")/.."
{
  printf '<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
  printf '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%%}</style>\n</head>\n<body>\n'
  cat artifact/losfee.html
  printf '\n</body>\n</html>\n'
} > index.html
echo "index.html aktualisiert"
