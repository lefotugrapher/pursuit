#!/usr/bin/env bash
# Move Pursuit to another machine without losing anything, and without leaving secrets in plain text.
#   scripts/pack.sh export            -> pursuit-YYYYMMDD.pack.enc (config, CV, database, CVs/letters, .env.local), AES-256 encrypted
#   scripts/pack.sh import FILE.enc   -> restores it into this checkout (asks before overwriting)
# You choose the passphrase; it is never stored. Lose it and the pack cannot be opened.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
need() { command -v "$1" >/dev/null || { echo "error: $1 is required" >&2; exit 1; }; }
need tar; need openssl
# Optional, for scripted use: PURSUIT_PACK_PASS in the environment (otherwise openssl asks you).
PASSOPT=(); [[ -n "${PURSUIT_PACK_PASS:-}" ]] && PASSOPT=(-pass env:PURSUIT_PACK_PASS)

case "${1:-}" in
  export)
    stamp="$(date +%Y%m%d-%H%M)"; out="${ROOT}/pursuit-${stamp}.pack.enc"; tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # Consistent database copy even while the worker is writing.
    if [[ -f data/pursuit.db ]]; then
      node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/pursuit.db');d.exec(\"VACUUM INTO '$tmp/pursuit.db'\");d.close();"
    fi
    items=(config)
    [[ -f .env.local ]] && items+=(.env.local)
    [[ -d data/artifacts ]] && items+=(data/artifacts)
    [[ -d data/screenshots ]] && items+=(data/screenshots)
    tar -czf "$tmp/pack.tgz" "${items[@]}" -C "$tmp" $( [[ -f "$tmp/pursuit.db" ]] && echo pursuit.db )
    openssl enc -aes-256-cbc -pbkdf2 -iter 250000 -salt "${PASSOPT[@]}" -in "$tmp/pack.tgz" -out "$out"
    chmod 600 "$out"
    echo "Wrote $out ($(du -h "$out" | cut -f1)). Copy it to the new machine, then run: scripts/pack.sh import $(basename "$out")"
    ;;
  import)
    file="${2:-}"; [[ -f "$file" ]] || { echo "usage: $0 import FILE.pack.enc" >&2; exit 2; }
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 "${PASSOPT[@]}" -in "$file" -out "$tmp/pack.tgz"
    if [[ -f data/pursuit.db || -f .env.local ]]; then
      read -r -p "This machine already has Pursuit data. Overwrite it with the pack? [y/N] " ans
      [[ "$ans" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 1; }
    fi
    mkdir -p data
    tar -xzf "$tmp/pack.tgz" -C "$ROOT"
    [[ -f "$ROOT/pursuit.db" ]] && mv "$ROOT/pursuit.db" data/pursuit.db
    chmod 600 .env.local 2>/dev/null || true
    echo "Imported. Next: scripts/setup.sh"
    ;;
  *) echo "usage: $0 export | import FILE.pack.enc" >&2; exit 2 ;;
esac
