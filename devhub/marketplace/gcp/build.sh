#!/usr/bin/env bash
# Builds the Google Cloud Marketplace release into your staging registry:
#   $REGISTRY/devhub:$VERSION            the app (primary image)
#   $REGISTRY/devhub/ubbagent:$VERSION   Google's metering agent, copied in
#   $REGISTRY/devhub/deployer:$TRACK     the deployer (track tag, e.g. 0.1)
#
#   REGISTRY=gcr.io/your-project SERVICE_NAME=devhub.endpoints.your-project.cloud.goog \
#   PARTNER_ID=your-partner-id PARTNER_NAME="Your Company" VERSION=0.1.0 ./marketplace/gcp/build.sh [--push]
#
# Needs docker, yq v4 and crane (or gcloud) to copy the agent image. Run from devhub/.
# Then test with: mpdev verify --deployer=$REGISTRY/devhub/deployer:$TRACK
set -euo pipefail
: "${REGISTRY:?set REGISTRY to your staging registry, e.g. gcr.io/your-project}"
: "${SERVICE_NAME:?set SERVICE_NAME to the service name from the Producer Portal}"
: "${PARTNER_ID:?set PARTNER_ID to your Producer Portal partner ID}"
VERSION=${VERSION:-$(yq '.appVersion' charts/devhub/Chart.yaml)}
TRACK=${VERSION%.*}
PUSH=${1:-}
DIR=marketplace/gcp

docker build -t "$REGISTRY/devhub:$VERSION" .
rm -rf "$DIR/chart" && mkdir -p "$DIR/chart"
cp -r charts/devhub "$DIR/chart/devhub"
yq -i ".version = \"$VERSION\" | .appVersion = \"$VERSION\"" "$DIR/chart/devhub/Chart.yaml"
# Marketplace installs: metering on, no ServiceAccount created by the chart (Marketplace rule),
# and the listing's identifiers on the Application resource.
yq -i "
  .gcpMarketplace.enabled = true |
  .gcpMarketplace.serviceName = \"$SERVICE_NAME\" |
  .gcpMarketplace.partnerId = \"$PARTNER_ID\" |
  .gcpMarketplace.partnerName = \"${PARTNER_NAME:-}\" |
  .serviceAccount.create = false |
  .image.repository = \"$REGISTRY/devhub\" |
  .image.tag = \"$VERSION\" |
  .gcpMarketplace.ubbagentImage = \"$REGISTRY/devhub/ubbagent:$VERSION\"
" "$DIR/chart/devhub/values.yaml"
yq -i ".x-google-marketplace.publishedVersion = \"$VERSION\"" "$DIR/schema.yaml"
docker build -t "$REGISTRY/devhub/deployer:$TRACK" -t "$REGISTRY/devhub/deployer:$VERSION" "$DIR"

if [ "$PUSH" = "--push" ]; then
  docker push "$REGISTRY/devhub:$VERSION"
  docker push "$REGISTRY/devhub/deployer:$TRACK"
  docker push "$REGISTRY/devhub/deployer:$VERSION"
  crane copy gcr.io/cloud-marketplace-tools/metering/ubbagent:latest "$REGISTRY/devhub/ubbagent:$VERSION"
fi
echo "Built $REGISTRY/devhub:$VERSION and $REGISTRY/devhub/deployer:$TRACK"
