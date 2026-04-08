#!/usr/bin/env bash
# deploy-web.sh — Build and deploy the Next.js frontend to Cloudflare Workers
# Usage: ./deploy/deploy-web.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/web"

echo "==> Building Next.js..."
cd "$WEB_DIR"
NEXT_PUBLIC_API_URL=https://multica.maskzh.com \
NEXT_PUBLIC_WS_URL=wss://multica.maskzh.com/ws \
  pnpm exec next build

echo "==> Patching functions-config-manifest to remove nodejs middleware entry..."
echo '{"version":1,"functions":{}}' > .next/server/functions-config-manifest.json

echo "==> Bundling with OpenNext (skip next build)..."
pnpm exec opennextjs-cloudflare build --skipNextBuild

echo "==> Deploying multica-web Worker..."
pnpm exec opennextjs-cloudflare deploy

echo "==> Done. multica-web deployed successfully."
