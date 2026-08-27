#!/bin/bash
# setup-secrets.sh
# Run this once, locally, in your project folder (after `firebase use --add`).
# It prompts for each secret and sends it straight to Firebase's secret manager.
# Nothing gets written to disk or committed to git.

set -e

SECRETS=(
  "BIGISUB_TOKEN"
  "BIGISUB_PIN"
  "BIGISUB_ACCOUNT_NUMBER"
  "FLW_SECRET_KEY"
  "FLW_CLIENT_SECRET"
  "FLW_ENCRYPTION_KEY"
  "FLW_WEBHOOK_SECRET_HASH"
  "BREVO_API_KEY"
  "VAPID_PRIVATE_KEY"
)

echo "This will set ${#SECRETS[@]} secrets on your Firebase project."
echo "You'll be prompted for each value — paste it and press Enter."
echo ""

for SECRET in "${SECRETS[@]}"; do
  echo "→ Setting $SECRET"
  firebase functions:secrets:set "$SECRET"
  echo ""
done

echo "All secrets set. Verify with: firebase functions:secrets:access BIGISUB_TOKEN"
echo "Remember: any function that reads a secret must list it in its 'secrets' array (see index.js)."
