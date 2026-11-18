#!/usr/bin/env bash
# One-time setup on a new machine (Docker route). Safe to re-run.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
command -v docker >/dev/null || { echo "Install Docker first: https://docs.docker.com/get-docker/"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start it and re-run."; exit 1; }

if [[ ! -f .env.local ]]; then
  cp .env.example .env.local && chmod 600 .env.local
  echo "Created .env.local from the example. Fill in your keys (or import a pack: scripts/pack.sh import FILE)."
fi
for f in profile facts answers sources; do
  [[ -f "config/$f.json" ]] || echo "warning: config/$f.json missing; Pursuit will use the example file until you import your pack."
done
[[ -f config/cv/Kshitiz_Mittal_CV.tex ]] || echo "warning: config/cv/Kshitiz_Mittal_CV.tex missing (master CV). Import your pack or copy it in."

if [[ ! -f deploy/searxng/settings.yml ]]; then
  secret="$(openssl rand -hex 32)"
  sed "s/__SECRET__/${secret}/" deploy/searxng/settings.example.yml > deploy/searxng/settings.yml
fi
mkdir -p data
docker compose up -d --build
echo
echo "Pursuit is starting. Dashboard: http://localhost:7020 (on a server, use: ssh -L 7020:localhost:7020 <server>)"
echo "Logs: docker compose logs -f worker"
