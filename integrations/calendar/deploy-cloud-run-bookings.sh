#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-portfolio-bookings}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-nikhil-bookings-api}"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-nikhil-bookings-runtime@portfolio-bookings.iam.gserviceaccount.com}"
SOURCE_DIR="${SOURCE_DIR:-/tmp/nikhil-bookings-source}"
WHATSAPP_PHONE_NUMBER_ID="${WHATSAPP_PHONE_NUMBER_ID:-}"
WHATSAPP_GRAPH_API_VERSION="${WHATSAPP_GRAPH_API_VERSION:-}"
WHATSAPP_TEMPLATE_NAME="${WHATSAPP_TEMPLATE_NAME:-booking_confirmation}"
WHATSAPP_TEMPLATE_LANGUAGE="${WHATSAPP_TEMPLATE_LANGUAGE:-en}"
WHATSAPP_ACCESS_TOKEN_SECRET="${WHATSAPP_ACCESS_TOKEN_SECRET:-}"

cd "$(dirname "$0")/../.."

gcloud config set project "$PROJECT_ID"

rm -rf "$SOURCE_DIR"
node integrations/calendar/prepare-deployment.mjs "$SOURCE_DIR"

cd "$SOURCE_DIR"
echo "Deploying from prepared source bundle:"
find . -maxdepth 4 -type f | sort

ENV_VARS="CALENDAR_CREDENTIALS_FILE=/secrets/calendar/calendar-runtime.json,ALLOWED_ORIGINS=https://cracker-jack.github.io,BOOKINGS_PROJECT_ID=$PROJECT_ID"
SECRETS="/secrets/calendar/calendar-runtime.json=nikhil-calendar-runtime:latest,RAZORPAY_KEY_ID=razorpay-key-id:latest,RAZORPAY_KEY_SECRET=razorpay-key-secret:latest,RAZORPAY_WEBHOOK_SECRET=razorpay-webhook-secret:latest"

if [[ -n "$WHATSAPP_PHONE_NUMBER_ID" || -n "$WHATSAPP_GRAPH_API_VERSION" || -n "$WHATSAPP_ACCESS_TOKEN_SECRET" ]]; then
  if [[ -z "$WHATSAPP_PHONE_NUMBER_ID" || -z "$WHATSAPP_GRAPH_API_VERSION" || -z "$WHATSAPP_ACCESS_TOKEN_SECRET" ]]; then
    echo "WhatsApp deployment requires WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_GRAPH_API_VERSION, and WHATSAPP_ACCESS_TOKEN_SECRET." >&2
    exit 1
  fi
  ENV_VARS+=",WHATSAPP_PHONE_NUMBER_ID=$WHATSAPP_PHONE_NUMBER_ID,WHATSAPP_GRAPH_API_VERSION=$WHATSAPP_GRAPH_API_VERSION,WHATSAPP_TEMPLATE_NAME=$WHATSAPP_TEMPLATE_NAME,WHATSAPP_TEMPLATE_LANGUAGE=$WHATSAPP_TEMPLATE_LANGUAGE"
  SECRETS+=",WHATSAPP_ACCESS_TOKEN=$WHATSAPP_ACCESS_TOKEN_SECRET"
fi

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
  --set-env-vars="$ENV_VARS" \
  --set-secrets="$SECRETS"

SERVICE_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "Service URL: $SERVICE_URL"
echo "Verify with: curl -i -X POST \"$SERVICE_URL/api/availability\" -H 'Origin: https://cracker-jack.github.io' -H 'Content-Type: application/json' -d '{\"serviceId\":\"mentorship\",\"date\":\"2026-09-19\"}'"
