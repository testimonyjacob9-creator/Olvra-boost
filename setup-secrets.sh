#!/bin/bash
# setup-secrets.sh
# Run this once, locally (Termux is fine), after `netlify link` has connected
# this folder to your Olvra Boost site on Netlify.
# It prompts for each env var and sends it straight to Netlify — nothing
# gets written to disk or committed to git.
#
# Requires the Netlify CLI: npm install -g netlify-cli

set -e

SECRETS=(
  "BIGISUB_TOKEN"
  "FIREBASE_PROJECT_ID"
  "FIREBASE_CLIENT_EMAIL"
  "FIREBASE_PRIVATE_KEY"
  "FIREBASE_WEB_API_KEY"
  "FIREBASE_AUTH_DOMAIN"
  "FIREBASE_STORAGE_BUCKET"
  "FIREBASE_MESSAGING_SENDER_ID"
  "FIREBASE_APP_ID"
  "FLW_PUBLIC_KEY"
  "FLW_SECRET_KEY"
  "FLW_WEBHOOK_SECRET_HASH"
  "BREVO_API_KEY"
  "BREVO_SENDER_EMAIL"
  "APP_URL"
)

echo "This will set ${#SECRETS[@]} environment variables on your linked Netlify site."
echo "You'll be prompted for each value — paste it and press Enter (leave blank to skip)."
echo ""

for SECRET in "${SECRETS[@]}"; do
  read -r -p "→ $SECRET: " VALUE
  if [ -n "$VALUE" ]; then
    netlify env:set "$SECRET" "$VALUE"
  else
    echo "  (skipped)"
  fi
  echo ""
done

echo "Done. Verify with: netlify env:list"
echo "Trigger a redeploy afterward so the build picks up new values: netlify deploy --prod"
