# AID Kitty — Publisher Guide

> Everything you need as the publisher to manage, deploy, update, and monetize AID Kitty on Azure Marketplace.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Billing & Costs](#billing--costs)
3. [Deployment Models](#deployment-models)
4. [Managing Your Test Deployment](#managing-your-test-deployment)
5. [Deploying a New Instance](#deploying-a-new-instance)
6. [Updating the Application](#updating-the-application)
7. [Container Registry (ACR) Management](#container-registry-acr-management)
8. [Marketplace Submission](#marketplace-submission)
9. [Customer Experience](#customer-experience)
10. [Maintenance & Troubleshooting](#maintenance--troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────┐       ┌─────────────────────────────┐
│    YOUR INFRASTRUCTURE      │       │   CUSTOMER'S SUBSCRIPTION   │
│                             │       │                             │
│  ┌───────────────────────┐  │       │  ┌───────────────────────┐  │
│  │ Azure Container       │  │ pull  │  │ App Service           │  │
│  │ Registry (ACR)        │◄─┼───────┼──│ (Docker container)    │  │
│  │ aidkittycr             │  │       │  └──────────┬────────────┘  │
│  └───────────────────────┘  │       │             │ connects      │
│                             │       │  ┌──────────▼────────────┐  │
│  Cost: ~$5/mo               │       │  │ PostgreSQL            │  │
│                             │       │  │ (their data)          │  │
└─────────────────────────────┘       │  └───────────────────────┘  │
                                      │  ┌───────────────────────┐  │
                                      │  │ Key Vault             │  │
                                      │  │ (their secrets)       │  │
                                      │  └───────────────────────┘  │
                                      │                             │
                                      │  Cost: ~$26-$239/mo        │
                                      │  (paid by customer)        │
                                      └─────────────────────────────┘
```

---

## Billing & Costs

### What YOU Pay (Publisher)

| Resource | Monthly Cost | Required? | How to Stop |
|:---|:---|:---|:---|
| ACR Basic (`aidkittycr`) | ~$5/mo | ✅ Yes — customers pull images from here | Cannot remove while you have customers |
| Test deployment | ~$26/mo | ❌ Optional — for testing only | Delete with `az group delete` (see below) |
| Partner Center | $99 one-time | ✅ Yes — to list on marketplace | One-time fee |

**Minimum ongoing cost: ~$5/mo** (ACR only, after deleting test deployment)

### What CUSTOMERS Pay (to Azure, Not to You)

| Resource | SKU | Monthly Cost |
|:---|:---|:---|
| App Service Plan | B1 (Basic) | ~$13 |
| | B2 (Basic) | ~$26 |
| | P1v3 (Premium) | ~$74 |
| PostgreSQL Flexible Server | Standard_B1ms | ~$13 |
| | Standard_B2s | ~$26 |
| | Standard_D2s_v3 | ~$98 |
| Key Vault | Standard | ~$0.03 |
| **Total range** | | **~$26 – $239/mo** |

Customers choose their SKU during deployment. They pay Azure directly.

### How YOU Make Money

| Model | Description | Setup |
|:---|:---|:---|
| **Free** | No charge — for adoption/awareness | Select in Partner Center |
| **BYOL** | You bill customers separately (Stripe, invoices, etc.) | Select in Partner Center, set up your own billing |
| **Flat rate** | Microsoft bills customer monthly, pays you (minus 3%) | Configure pricing in Partner Center |
| **Usage-based** | Per-user or per-API-call pricing via Microsoft | More complex — requires metering API |

---

## Deployment Models

### Model 1: Azure Managed Application (What We Built)

```
Customer clicks "Get It Now" on Azure Marketplace
    → ARM template deploys into THEIR subscription
    → Each customer gets their own App Service + DB + Key Vault
    → Customer owns their data, you maintain the code
```

**Best for:** Enterprise customers, data sovereignty, compliance (HIPAA, GDPR)

### Model 2: AppSource SaaS (Also Built — Separate Branch)

```
Customer clicks "Get It Now" on AppSource
    → Redirected to YOUR landing page
    → Signs in with Microsoft SSO
    → Uses YOUR shared infrastructure
    → You manage everything
```

**Best for:** Consumer/SMB, simpler operations, multi-tenant

---

## Managing Your Test Deployment

### Current Test Resources

| Resource | Name | Region |
|:---|:---|:---|
| Resource Group | `aidkitty-prod` | West US 2 |
| App Service | `aidkitty-app-c2fbpqdpgisrq` | West US 2 |
| PostgreSQL | `aidkitty-db-c2fbpqdpgisrq` | West US 2 |
| Key Vault | `aidkitty-kv-c2fbpqdp` | West US 2 |
| ACR | `aidkittycr` | West US 2 |
| **App URL** | `https://aidkitty-app-c2fbpqdpgisrq.azurewebsites.net` | |

### Delete Test Deployment (Save ~$26/mo)

```bash
# Delete everything EXCEPT the ACR (you need ACR for customers)
az group delete --name aidkitty-prod --yes --no-wait

# Verify deletion
az group show --name aidkitty-prod 2>&1
# Should return "ResourceGroupNotFound"
```

> ⚠️ **Keep the ACR!** If you delete `aidkittycr`, customers won't be able to pull the Docker image. Move it to a separate resource group if needed:
> ```bash
> az group create --name aidkitty-acr-rg --location westus2
> # Then recreate ACR there
> ```

### Start Test Deployment Again

```bash
# 1. Create resource group
az group create --name aidkitty-test --location westus2

# 2. Deploy
JWT_SECRET=$(openssl rand -base64 32)
az deployment group create \
  --resource-group aidkitty-test \
  --template-file azure/mainTemplate.json \
  --parameters \
    appName=aidkitty \
    adminEmail=krishna@nelait.com \
    jwtSecret="$JWT_SECRET" \
    postgresAdminPassword="YourStrongPassword123" \
    appServiceSkuName=B1 \
    postgresSku=Standard_B1ms \
    dockerImage="aidkittycr.azurecr.io/aidkitty:latest" \
    microsoftClientId="6be8a38a-6e2b-4104-a812-88898321d4c1" \
    microsoftTenantId="9f558aa6-3506-4e75-a66d-96c5a3baedf2"

# 3. Get the app URL
az deployment group show --resource-group aidkitty-test \
  --name mainTemplate --query "properties.outputs.appUrl.value" -o tsv
```

---

## Deploying a New Instance

This is what the ARM template automates for customers. For manual deployments:

### Step 1: Choose Region & Resource Group

```bash
az group create --name <resource-group-name> --location <region>
```

Available regions: `eastus`, `westus2`, `eastus2`, `centralus`, `westeurope`, `northeurope`, `southeastasia`, `australiaeast`

### Step 2: Deploy ARM Template

```bash
az deployment group create \
  --resource-group <resource-group-name> \
  --template-file azure/mainTemplate.json \
  --parameters \
    appName=<unique-name> \
    adminEmail=<email> \
    jwtSecret="$(openssl rand -base64 32)" \
    postgresAdminPassword="<strong-password>" \
    appServiceSkuName=B1 \
    postgresSku=Standard_B1ms \
    dockerImage="aidkittycr.azurecr.io/aidkitty:latest" \
    microsoftClientId="<client-id>" \
    microsoftTenantId="<tenant-id>"
```

### Step 3: Verify

```bash
# Get outputs
az deployment group show --resource-group <rg> --name mainTemplate \
  --query "properties.outputs"

# Health check
curl https://<app-name>.azurewebsites.net/api/health
```

### Step 4: Add API Keys (Post-Deployment)

```bash
az webapp config appsettings set \
  --name <app-name> \
  --resource-group <rg> \
  --settings OPENAI_API_KEY="sk-..." ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Updating the Application

When you make code changes and want to push updates:

### 1. Build & Push New Image

```bash
# Build for AMD64 (Azure runs AMD64, not ARM)
docker buildx build --platform linux/amd64 \
  -t aidkittycr.azurecr.io/aidkitty:latest \
  -t aidkittycr.azurecr.io/aidkitty:v1.2.0 \
  --push .
```

> **Always tag with both `latest` and a version number** for rollback capability.

### 2. Restart Customer Instances

Customers restart their App Service to pull the new image:
```bash
az webapp restart --name <app-name> --resource-group <rg>
```

Or configure **continuous deployment** so they auto-update:
```bash
az webapp config appsettings set \
  --name <app-name> --resource-group <rg> \
  --settings DOCKER_ENABLE_CI=true
```

### 3. Rolling Back

If an update breaks something:
```bash
# Point the App Service back to a previous version
az webapp config container set \
  --name <app-name> --resource-group <rg> \
  --docker-custom-image-name aidkittycr.azurecr.io/aidkitty:v1.1.0

az webapp restart --name <app-name> --resource-group <rg>
```

### 4. Database Migrations

Migrations run automatically on app startup via `runMigrations()`. If a migration requires manual intervention:

```bash
# SSH into the container
az webapp ssh --name <app-name> --resource-group <rg>

# Or check logs
az webapp log tail --name <app-name> --resource-group <rg>
```

---

## Container Registry (ACR) Management

### Login to ACR

```bash
az acr login --name aidkittycr
```

### List Images

```bash
az acr repository list --name aidkittycr
az acr repository show-tags --name aidkittycr --repository aidkitty
```

### Delete Old Image Tags

```bash
# Keep last 5 versions, delete older ones
az acr repository delete --name aidkittycr --image aidkitty:v1.0.0 --yes
```

### ACR Credentials (for customer App Services)

```bash
az acr credential show --name aidkittycr
```

---

## Marketplace Submission

### Prerequisites

1. **Microsoft Partner Center account** — https://partner.microsoft.com/dashboard
   - Requires a Microsoft work account (not personal @outlook/@gmail)
   - $99 one-time registration fee
   - Verification: 1-5 business days

### Required Listing Assets

| Asset | Spec | Status |
|:---|:---|:---|
| App screenshots | 1280×720 or 1366×768 PNG (min 1, max 5) | ⬜ Need to create |
| Logo — Small | 48×48 PNG | ⬜ Need to create |
| Logo — Medium | 90×90 PNG | ⬜ Need to create |
| Logo — Large | 216×216 PNG | ⬜ Need to create |
| Logo — Wide | 255×115 PNG | ⬜ Need to create |
| Short description | Max 100 characters | ⬜ Need to write |
| Long description | Max 3000 characters (HTML supported) | ✅ In `docs/marketplace/listing.md` |
| Privacy policy URL | Public URL | ✅ In `docs/marketplace/privacy-policy.md` |
| Terms of use URL | Public URL | ✅ In `docs/marketplace/terms-of-use.md` |
| Support URL | Public URL | ✅ In `docs/marketplace/support.md` |

### Submission Steps

1. **Log in** to [Partner Center](https://partner.microsoft.com/dashboard)
2. Go to **Marketplace offers** → **+ New offer** → **Azure Application**
3. Fill in:
   - **Offer ID**: `aidkitty`
   - **Offer alias**: `AID Kitty - AI-Powered MVP Generator`
4. **Plan setup**:
   - Plan type: **Managed Application**
   - Plan name: e.g., `Basic`, `Professional`
5. **Technical configuration**:
   - Upload `.zip` containing `mainTemplate.json` + `createUiDefinition.json`:
     ```bash
     cd azure && zip ../aidkitty-managed-app.zip mainTemplate.json createUiDefinition.json
     ```
   - Set deployment version: `1.0.0`
6. **Listing** — add descriptions, screenshots, logos
7. **Preview** — test with a preview audience (your own Azure tenant)
8. **Publish** → **Go live**
9. **Microsoft review**: 3-5 business days

### Create the Submission Package

```bash
# Make sure Bicep is compiled to JSON
az bicep build --file azure/mainTemplate.bicep --outfile azure/mainTemplate.json

# Create the zip package
cd azure
zip ../aidkitty-managed-app.zip mainTemplate.json createUiDefinition.json
cd ..

# Verify
unzip -l aidkitty-managed-app.zip
# Should contain:
#   mainTemplate.json
#   createUiDefinition.json
```

---

## Customer Experience

### What Customers See

```
1. Azure Marketplace → search "AID Kitty" → click "Get It Now"
                    ↓
2. Azure Portal deployment wizard:
   ┌──────────────────────────────────────┐
   │ Step 1: Basics                       │
   │   Subscription: [their sub]          │
   │   Resource group: [new or existing]  │
   │   Region: [dropdown]                 │
   ├──────────────────────────────────────┤
   │ Step 2: Infrastructure               │
   │   App Service size: [B1/B2/P1v3]     │
   │   Database size: [B1ms/B2s/D2sv3]    │
   │   DB admin password: [*********]     │
   ├──────────────────────────────────────┤
   │ Step 3: Microsoft SSO (optional)     │
   │   Client ID: [optional]              │
   │   Tenant ID: [optional]              │
   ├──────────────────────────────────────┤
   │ Step 4: AI Providers                 │
   │   OpenAI key: [optional]             │
   │   Anthropic key: [optional]          │
   └──────────────────────────────────────┘
                    ↓
3. Click "Review + Create" → deploys in ~5 minutes
                    ↓
4. Gets their own URL: https://<app>-<unique>.azurewebsites.net
```

### What Each Customer Gets

- ✅ Their own App Service (Docker container)
- ✅ Their own PostgreSQL database (fully isolated)
- ✅ Their own Key Vault (secrets)
- ✅ Full access to all resources in their Azure Portal
- ✅ Their own billing (they pay Azure directly)
- ❌ No access to your source code (only the compiled Docker image)

### Data Isolation

Each customer deployment is **completely isolated**:
- Separate database server — no shared tables
- Separate Key Vault — unique JWT secrets
- Separate App Service — independent scaling and restarts
- **Customers CAN access their own database** (it's in their subscription)

---

## Maintenance & Troubleshooting

### Monitoring a Customer Instance

```bash
# View app logs
az webapp log tail --name <app-name> --resource-group <rg>

# Download logs
az webapp log download --name <app-name> --resource-group <rg> \
  --log-file /tmp/logs.zip

# Check health
curl https://<app-name>.azurewebsites.net/api/health
```

### Common Issues

| Problem | Cause | Fix |
|:---|:---|:---|
| Container exits with code 1 | Missing env vars or DB connection failure | Check app settings + DB firewall rules |
| 503 Service Unavailable | Container still starting | Wait 60-90s after restart (B1 is slow) |
| Image pull failure | ACR credentials or networking | Verify AcrPull role + managed identity |
| `AADSTS50011` redirect error | Redirect URI not configured in Entra ID | Add the production URL to app registration |
| Health returns `availableProviders: []` | No AI API keys set | Add `OPENAI_API_KEY` via app settings |

### Scaling a Customer Instance

```bash
# Scale up the App Service Plan
az appservice plan update --name <plan-name> --resource-group <rg> --sku P1V3

# Scale up PostgreSQL
az postgres flexible-server update --name <db-name> --resource-group <rg> \
  --sku-name Standard_D2s_v3
```

### Database Backup & Restore

PostgreSQL Flexible Server has **automatic backups** (7-day retention by default):

```bash
# Restore to a point in time
az postgres flexible-server restore \
  --name <new-server-name> \
  --source-server <original-server-name> \
  --resource-group <rg> \
  --restore-time "2026-03-28T12:00:00Z"
```

### Secret Rotation

```bash
# Rotate JWT secret
az webapp config appsettings set --name <app-name> --resource-group <rg> \
  --settings JWT_SECRET="$(openssl rand -base64 32)"
# Note: All active user sessions will be invalidated

# Rotate database password
az postgres flexible-server update --name <db-name> --resource-group <rg> \
  --admin-password "NewStrongPassword123"
# Then update the app:
az webapp config appsettings set --name <app-name> --resource-group <rg> \
  --settings DATABASE_URL="postgresql://...new-password...@..."
```

### Deleting a Deployment Entirely

```bash
# This deletes EVERYTHING — App Service, PostgreSQL, Key Vault
az group delete --name <resource-group-name> --yes --no-wait

# Verify
az group show --name <resource-group-name>
# Should show "ResourceGroupNotFound"
```

---

## Quick Reference Commands

```bash
# Login
az login

# List all your resource groups
az group list --query "[].{name:name, location:location}" -o table

# List deployments in a resource group
az deployment group list --resource-group <rg> -o table

# Build + push Docker image
docker buildx build --platform linux/amd64 \
  -t aidkittycr.azurecr.io/aidkitty:latest --push .

# Restart an App Service
az webapp restart --name <app-name> --resource-group <rg>

# Check app settings
az webapp config appsettings list --name <app-name> --resource-group <rg> \
  --query "[].{name:name}" -o table

# Set app settings
az webapp config appsettings set --name <app-name> --resource-group <rg> \
  --settings KEY=VALUE

# Create submission zip
cd azure && zip ../aidkitty-managed-app.zip mainTemplate.json createUiDefinition.json
```
