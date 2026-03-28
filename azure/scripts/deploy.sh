#!/bin/bash
# ====================================================================
# AID Kitty — Azure Post-Deployment Script
# Runs database migrations after the managed application is deployed.
# ====================================================================

set -euo pipefail

echo "================================================"
echo " AID Kitty — Post-Deployment Configuration"
echo "================================================"

# Check required environment
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set."
  exit 1
fi

echo ""
echo "1. Running database migrations..."
npx drizzle-kit migrate
echo "   ✅ Migrations complete."

echo ""
echo "2. Seeding prompt templates..."
npx tsx server/seed-prompt-templates.ts 2>/dev/null || echo "   ⚠️  Template seeding skipped (may already exist)."

echo ""
echo "================================================"
echo " Deployment complete!"
echo " App URL: ${FRONTEND_URL:-https://your-app.azurewebsites.net}"
echo "================================================"
