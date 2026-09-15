#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-portfolio-bookings}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-nikhil-bookings-api}"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-nikhil-bookings-runtime@portfolio-bookings.iam.gserviceaccount.com}"
SOURCE_DIR="${SOURCE_DIR:-/tmp/nikhil-bookings-source}"

cd "$(dirname "$0")/../.."

gcloud config set project "$PROJECT_ID"

rm -rf "$SOURCE_DIR"
node integrations/calendar/prepare-deployment.mjs "$SOURCE_DIR"

cd "$SOURCE_DIR"
echo "Deploying from prepared source bundle:"
find . -maxdepth 4 -type f | sort

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUNTIME_SERVICE_ACCOUNT" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 1 \
  --concurrency 8 \
  --memory 256Mi \
  --cpu 1 \
  --set-env-vars="CALENDAR_CREDENTIALS_FILE=/secrets/calendar/calendar-runtime.json,ALLOWED_ORIGINS=https://cracker-jack.github.io,BOOKINGS_PROJECT_ID=$PROJECT_ID" \
  --set-secrets="/secrets/calendar/calendar-runtime.json=nikhil-calendar-runtime:latest,RAZORPAY_KEY_ID=razorpay-key-id:latest,RAZORPAY_KEY_SECRET=razorpay-key-secret:latest,RAZORPAY_WEBHOOK_SECRET=razorpay-webhook-secret:latest"

SERVICE_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "Service URL: $SERVICE_URL"
echo "Verify with: curl -i -X POST \"$SERVICE_URL/api/availability\" -H 'Origin: https://cracker-jack.github.io' -H 'Content-Type: application/json' -d '{\"serviceId\":\"mentorship\",\"date\":\"2026-09-19\"}'"
