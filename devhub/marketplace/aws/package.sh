#!/usr/bin/env bash
# Builds the AWS Marketplace release: the image and Helm chart, pushed to the ECR repositories
# AWS Marketplace gives you for the product (Server products > your product > Add repositories).
#
#   MARKETPLACE_REGISTRY=709825985650.dkr.ecr.us-east-1.amazonaws.com/your-seller-prefix \
#   PRODUCT_SKU=<product SKU from the AWS Marketplace Management Portal> \
#   VERSION=0.1.0 ./marketplace/aws/package.sh [--push]
#
# Needs docker (buildx), helm 3.8+ and yq v4. Run from devhub/. Without --push it only builds.
set -euo pipefail
: "${MARKETPLACE_REGISTRY:?set MARKETPLACE_REGISTRY to the AWS Marketplace ECR registry and prefix}"
: "${PRODUCT_SKU:?set PRODUCT_SKU to the product SKU}"
VERSION=${VERSION:-$(yq '.appVersion' charts/devhub/Chart.yaml)}
PUSH=${1:-}
OUT=marketplace/aws/build
rm -rf "$OUT" && mkdir -p "$OUT"

# AWS Marketplace scans images and serves them from its own registry; the chart must point there.
IMAGE="$MARKETPLACE_REGISTRY/devhub"
docker buildx build --platform linux/amd64,linux/arm64 -t "$IMAGE:$VERSION" ${PUSH:+--push} .

cp -r charts/devhub "$OUT/devhub"
yq -i "
  .version = \"$VERSION\" | .appVersion = \"$VERSION\"
" "$OUT/devhub/Chart.yaml"
yq -i "
  .image.repository = \"$IMAGE\" |
  .image.tag = \"$VERSION\" |
  .awsMarketplace.productSku = \"$PRODUCT_SKU\"
" "$OUT/devhub/values.yaml"
helm lint --strict "$OUT/devhub"
helm package "$OUT/devhub" -d "$OUT"
if [ "$PUSH" = "--push" ]; then
  aws ecr get-login-password --region us-east-1 | helm registry login --username AWS --password-stdin "${MARKETPLACE_REGISTRY%%/*}"
  helm push "$OUT/devhub-$VERSION.tgz" "oci://$MARKETPLACE_REGISTRY"
fi
echo "Built $IMAGE:$VERSION and $OUT/devhub-$VERSION.tgz"
