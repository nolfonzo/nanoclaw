#!/usr/bin/env bash
# Build and (re)start the Qantas award monitor dashboard.
# Run this whenever you change src/qantas-dashboard.ts.
set -e
cd "$(dirname "$0")"

docker build -f Dockerfile.dashboard -t nanoclaw-dashboard:latest .
docker rm -f nanoclaw-dashboard 2>/dev/null || true
docker run -d \
  --name nanoclaw-dashboard \
  --restart always \
  -p 3001:3001 \
  -v /home/nolfonzo/weon:/workspace/extra/weon \
  -v /home/nolfonzo/nanoclaw/data/ipc/main:/workspace/nanoclaw-ipc:ro \
  nanoclaw-dashboard:latest

echo "Dashboard running → http://100.114.240.29:3001"
