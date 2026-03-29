# AID Kitty — Azure Cost Management

> How billing works, what you're paying for, and how to minimize costs.

---

## Current Test Deployment Costs

| Resource | SKU | Monthly Cost | Charged When Stopped? |
|:---|:---|:---|:---|
| App Service Plan | B1 (Basic) | ~$13 | ✅ **Yes** — reserved compute, billed regardless |
| PostgreSQL Flexible Server | Standard_B1ms | ~$13 | ✅ **Yes** — compute + storage billed even when stopped |
| Key Vault | Standard | ~$0.03 | ✅ Yes (negligible) |
| Container Registry (ACR) | Basic | ~$5 | ✅ Yes — fixed monthly fee |
| **Total** | | **~$31/mo** | |

### Important: Stopping ≠ Free

- **App Service**: Stopping the app does **not** stop the App Service Plan billing. The plan is a reserved VM — you pay for the VM whether your app runs on it or not.
- **PostgreSQL**: You can stop the server (saves compute cost), but storage is still billed at ~$0.10/GB/mo.
- **ACR**: Fixed cost regardless of usage.
- **The only way to fully stop billing** is to **delete** the resources.

---

## Cost Reduction Options

### Option 1: Delete Everything (Saves ~$31/mo → $0/mo)

Delete the entire test resource group. You can redeploy anytime.

```bash
# Deletes App Service, PostgreSQL, Key Vault, AND ACR
az group delete --name aidkitty-prod --yes

# Verify deletion
az group show --name aidkitty-prod 2>&1
# Expected: "ResourceGroupNotFound"
```

**Pros**: Zero ongoing cost
**Cons**: Must rebuild ACR and redeploy when needed. If marketplace customers exist, they can't pull images until ACR is recreated.

**To redeploy later:**
```bash
# 1. Create resource group
az group create --name aidkitty-prod --location westus2

# 2. Recreate ACR
az acr create --resource-group aidkitty-prod --name aidkittycr --sku Basic --admin-enabled true

# 3. Login and push image
az acr login --name aidkittycr
docker buildx build --platform linux/amd64 -t aidkittycr.azurecr.io/aidkitty:latest --push .

# 4. Deploy ARM template
JWT_SECRET=$(openssl rand -base64 32)
az deployment group create \
  --resource-group aidkitty-prod \
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
```

---

### Option 2: Keep Only ACR (Saves ~$26/mo → ~$5/mo)

Move ACR to its own resource group, then delete the test deployment.

```bash
# Step 1: Create dedicated ACR resource group
az group create --name aidkitty-acr --location westus2

# Step 2: Create new ACR in the dedicated group
az acr create --resource-group aidkitty-acr --name aidkittycr2 --sku Basic --admin-enabled true
# Note: ACR names must be globally unique, use a different name if "aidkittycr" already exists

# Step 3: Copy image to new ACR
az acr login --name aidkittycr2
docker pull aidkittycr.azurecr.io/aidkitty:latest
docker tag aidkittycr.azurecr.io/aidkitty:latest aidkittycr2.azurecr.io/aidkitty:latest
docker push aidkittycr2.azurecr.io/aidkitty:latest

# Step 4: Delete the test resource group (including old ACR)
az group delete --name aidkitty-prod --yes
```

**Pros**: ACR stays available for marketplace customers (~$5/mo)
**Cons**: Must update ARM template `dockerImage` parameter to point to new ACR name

---

### Option 3: Scale Down (Saves ~$13/mo → ~$18/mo)

Use the free App Service tier for testing (limited features):

```bash
# Downgrade App Service Plan to Free tier
az appservice plan update \
  --name aidkitty-plan-c2fbpqdpgisrq \
  --resource-group aidkitty-prod \
  --sku F1
```

> ⚠️ **Free tier limitations**: No custom Docker containers, no SSL, 1GB storage, 60 min/day compute. This won't work for running the AID Kitty Docker image — use only if testing without Docker.

---

### Option 4: Stop PostgreSQL Only (Saves ~$10/mo → ~$21/mo)

If you want to keep the app running but don't need the database temporarily:

```bash
# Stop the PostgreSQL server (compute stops, storage still billed at ~$3/mo)
az postgres flexible-server stop \
  --name aidkitty-db-c2fbpqdpgisrq \
  --resource-group aidkitty-prod

# Start it again later
az postgres flexible-server start \
  --name aidkitty-db-c2fbpqdpgisrq \
  --resource-group aidkitty-prod
```

> ⚠️ The app will not work while PostgreSQL is stopped (API calls will fail).

---

## Recommendations By Scenario

| Scenario | Recommended Option | Monthly Cost |
|:---|:---|:---|
| **Done testing, no marketplace customers yet** | Option 1: Delete everything | $0 |
| **Marketplace listing submitted, waiting for approval** | Option 2: Keep only ACR | ~$5 |
| **Marketplace is live with customers** | Keep ACR running, delete test deployment | ~$5 |
| **Active development / testing** | Keep everything running | ~$31 |

---

## Customer Deployment Costs (For Reference)

When customers deploy via Azure Marketplace, **they pay their own Azure bill**:

| Tier | App Service | PostgreSQL | Key Vault | Total |
|:---|:---|:---|:---|:---|
| **Basic** | B1 ($13) | B1ms ($13) | $0.03 | **~$26/mo** |
| **Standard** | B2 ($26) | B2s ($26) | $0.03 | **~$52/mo** |
| **Premium** | P1v3 ($74) | D2s_v3 ($98) | $0.03 | **~$172/mo** |
| **Enterprise** | P2v3 ($148) | D4s_v3 ($196) | $0.03 | **~$344/mo** |

You do **not** pay for customer resources. Each customer's resources are in their own Azure subscription.

---

## Monitoring Your Costs

```bash
# View current month's cost
az consumption usage list \
  --start-date 2026-03-01 \
  --end-date 2026-03-31 \
  --query "[].{resource:instanceName, cost:pretaxCost, currency:currency}" \
  -o table

# Set a budget alert (get notified at $30)
az consumption budget create \
  --budget-name aidkitty-budget \
  --amount 30 \
  --category cost \
  --time-grain monthly \
  --start-date 2026-04-01 \
  --end-date 2027-04-01
```

Or view costs in **Azure Portal** → **Cost Management + Billing** → **Cost analysis**.
