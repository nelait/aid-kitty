# Selling Dev Hub through AWS and Google Cloud Marketplace

Dev Hub can be bought through either marketplace instead of with a license file. The code side is done: entitlement checks and usage reporting (`src/marketplace.ts`), chart support (`awsMarketplace.*`, `gcpMarketplace.*`), and build scripts here. What's left is the listing work in each seller console, which only the seller can do. This checklist covers it.

The pricing model each integration expects:

| | AWS Marketplace | Google Cloud Marketplace |
| --- | --- | --- |
| Product type | Container product, Helm chart delivery (EKS) | Kubernetes app (deployer image) |
| Pricing | Contract pricing: one dimension, **Users** (API name `Users`, unit Count), monthly or 1/2/3-year terms | Usage-based: one metric, **active_users**, reported every hour (one unit = one active person for one hour) |
| How Dev Hub checks it | Reads the buyer's AWS License Manager license (seat count, end date) and checks it out on every sync | Reports active people each hour to the metering agent (ubbagent) next to it, which forwards to Google |
| Seat limit | The purchased Users, plus Dev Hub's usual 10% true-up allowance | None: billed for every active person |
| If the check fails | The last good result holds for 30 days; then no new people (existing people and budget enforcement keep working) | Same, if the agent can't report for 30 days |
| If the subscription ends | No new people from the next check | Same, once reports stop being accepted |

Price the GCP metric per person-hour: for $X per person per month, use about X / 730 per unit (e.g. $10/month is about $0.0137 per person-hour).

## AWS Marketplace

**Once**
1. Register as an AWS Marketplace seller (AWS Marketplace Management Portal), with tax and banking details.
2. Create a **Container** product. Under pricing choose **Contract**, add one dimension with API name `Users` (unit: Count). The integration expects exactly this name; to use another, set `awsMarketplace.entitlement` to match.
3. Choose **AWS License Manager** integration for the contract. Note the **product SKU**.
4. Add repositories for the product; AWS gives you an ECR registry like `709825985650.dkr.ecr.us-east-1.amazonaws.com/<your-prefix>`.

**Each release**
1. Build and push the image and chart into that registry (from `devhub/`, with docker buildx, helm 3.8+, yq v4 and AWS credentials for the seller account):
   ```sh
   MARKETPLACE_REGISTRY=709825985650.dkr.ecr.us-east-1.amazonaws.com/<your-prefix> \
   PRODUCT_SKU=<product SKU> VERSION=0.1.0 ./marketplace/aws/package.sh --push
   ```
   The chart it pushes points at the marketplace image and has the product SKU set, so buyers only add their own settings.
2. Add a new version in the portal: the chart's OCI address, release notes, and the usage instructions below. AWS scans the image before publishing.

**Usage instructions for the listing** (edit as needed)
> 1. Create an IAM role for Dev Hub's service account (IRSA or EKS Pod Identity) with [`iam-policy.json`](aws/iam-policy.json) (License Manager read and checkout), plus the EC2 permissions in the admin guide if you use cloud workspaces.
> 2. `helm install devhub oci://<chart address> --version <version> -n devhub --create-namespace --set config.publicUrl=https://devhub.example.com --set config.auth.oidc.issuer=... --set config.auth.oidc.clientId=... --set secrets.existingSecret=devhub --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=<role ARN>`
> 3. Open Admin → License: it shows the people you purchased within a few minutes.

**Before submitting:** test with a limited (private) listing in a test account: buy it, install, and check Admin → License shows the seats; cancel and check new people are refused at the next sync.

## Google Cloud Marketplace

**Once**
1. Join the Google Cloud Partner Advantage program and get Producer Portal access.
2. Create a **Kubernetes app** product. Under pricing, add a usage-based metric with ID `active_users` (unit: hour); set the price per person-hour. Note the **service name** Google assigns for metering (like `devhub.endpoints.<project>.cloud.goog`) and your **partner ID**.
3. Set up a staging registry (gcr.io or Artifact Registry) in a project linked to the Producer Portal.

**Each release**
1. Build and push the app, the metering agent and the deployer (from `devhub/`, with docker, yq v4, crane and credentials for the staging registry). Google's tools images (`gcr.io/cloud-marketplace-tools/...`, the deployer base and ubbagent) don't allow anonymous pulls, so sign in first with an account in the Producer Portal (`gcloud auth configure-docker gcr.io`):
   ```sh
   REGISTRY=gcr.io/<your-project> SERVICE_NAME=<service name> PARTNER_ID=<partner ID> \
   PARTNER_NAME="Your Company" VERSION=0.1.0 ./marketplace/gcp/build.sh --push
   ```
   This turns metering on in the chart it packages, stops the chart creating a ServiceAccount (a Marketplace rule), and tags the deployer with the release track (`0.1`).
2. Verify on a GKE cluster: `mpdev verify --deployer=gcr.io/<your-project>/devhub/deployer:0.1`. It installs into a test namespace, checks the app comes up, and uninstalls. Run it with the test parameters a buyer would give: `--parameters='{"config.publicUrl": "https://devhub.test", "config.auth.oidc.issuer": "https://example.okta.com", "config.auth.oidc.clientId": "x", "secrets.existingSecret": "devhub"}'` (create that Secret first).
3. Submit the version in the Producer Portal.

The deployment form comes from [`gcp/schema.yaml`](gcp/schema.yaml): the address, OIDC issuer and client ID, the name of a Secret the buyer creates with `OIDC_CLIENT_SECRET` and connector keys, a storage class, and an optional Ingress.

## Not yet verified

The marketplace pages and seller consoles weren't reachable from where this was built. The integration follows:
- the AWS SDK's License Manager types and AWS's published issuer fingerprint;
- Google's `marketplace-k8s-app-tools` docs (schema v2, Helm deployer, billing integration);
- the ubbagent README.

Expect to adjust details during each marketplace's review. These are worth checking first:
- that the `Users` dimension name and Count unit match the product exactly;
- that `deployer_helm/onbuild` accepts this chart layout;
- that the ubbagent image runs as the pod's non-root user (1000);
- which deployer tag the Producer Portal wants for the version.
- the current address of Google's deployer base and ubbagent images. They returned 403 to anonymous pulls, so they may have moved to Artifact Registry; update `gcp/Dockerfile` and `gcpMarketplace.ubbagentImage` if so.
