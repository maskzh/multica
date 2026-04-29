#!/usr/bin/env bash
# deploy.sh — Build and deploy Multica to Cloudflare
# Usage:
#   ./deploy/deploy.sh           # deploy both web + backend
#   ./deploy/deploy.sh --web     # deploy web only
#   ./deploy/deploy.sh --backend # deploy backend only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/web"
CF_DIR="$SCRIPT_DIR/cloudflare"

DEPLOY_WEB=true
DEPLOY_BACKEND=true

for arg in "$@"; do
  case "$arg" in
    --web)     DEPLOY_BACKEND=false ;;
    --backend) DEPLOY_WEB=false ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ── Web ────────────────────────────────────────────────────────────────────────

if $DEPLOY_WEB; then
  echo "==> [web] Building Next.js..."
  cd "$WEB_DIR"
  STANDALONE=true \
  NEXT_PUBLIC_API_URL=https://multica.maskzh.com \
  NEXT_PUBLIC_WS_URL=wss://multica.maskzh.com/ws \
    pnpm exec next build

  echo "==> [web] Patching functions-config-manifest..."
  echo '{"version":1,"functions":{}}' > .next/server/functions-config-manifest.json

  echo "==> [web] Bundling with OpenNext..."
  pnpm exec opennextjs-cloudflare build --skipNextBuild

  echo "==> [web] Deploying multica-web Worker..."
  pnpm exec opennextjs-cloudflare deploy

  echo "==> [web] Done."
fi

# ── Backend ────────────────────────────────────────────────────────────────────

if $DEPLOY_BACKEND; then
  echo "==> [backend] Deploying multica Worker + container..."
  cd "$CF_DIR"
  npx wrangler deploy

  echo "==> [backend] Done."
fi

echo ""
echo "Deployment complete."
