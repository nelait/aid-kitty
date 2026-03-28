# AID Kitty — Azure Deployment Guide

## Overview

AID Kitty can be deployed as an **Azure Managed Application**, running entirely within a customer's Azure subscription. This guide covers deployment options, infrastructure, and configuration.

## Deployment Options

| Option | Best For | Hosting | Data Location |
|:---|:---|:---|:---|
| **AppSource SaaS** | Small teams, startups | We host (Railway) | Our infrastructure |
| **Azure Managed App** | Enterprises, compliance | Customer's Azure | Customer's Azure tenant |
| **Docker Self-Host** | Custom environments | Any Docker host | Your infrastructure |

---

## Azure Managed Application Deployment

### Prerequisites

- Azure subscription with Contributor role
- Azure CLI installed (`az --version`)

### What Gets Deployed

```
Resource Group
├── App Service Plan (Linux)
│   └── App Service (Docker container)
│       └── AID Kitty application
├── PostgreSQL Flexible Server (v15)
│   └── aidkitty database (32 GB)
├── Key Vault
│   ├── jwt-secret
│   └── db-password
└── Firewall rules (Azure services only)
```

### Step-by-Step Deployment

#### 1. Build the Docker Image

```bash
# From project root
docker build -t aidkitty:latest .

# Tag for your registry
docker tag aidkitty:latest your-registry.azurecr.io/aidkitty:latest

# Push to Azure Container Registry
az acr login --name your-registry
docker push your-registry.azurecr.io/aidkitty:latest
```

#### 2. Compile the ARM Template

```bash
# Compile Bicep to ARM JSON
az bicep build --file azure/mainTemplate.bicep --outfile azure/mainTemplate.json

# Validate the template
az deployment group validate \
  --resource-group my-resource-group \
  --template-file azure/mainTemplate.json \
  --parameters adminEmail=admin@company.com \
               jwtSecret="$(openssl rand -base64 32)" \
               postgresAdminPassword="StrongPass123!"
```

#### 3. Deploy to Azure

```bash
# Create resource group
az group create --name aidkitty-rg --location eastus

# Deploy
az deployment group create \
  --resource-group aidkitty-rg \
  --template-file azure/mainTemplate.json \
  --parameters \
    appName=aidkitty \
    adminEmail=admin@company.com \
    jwtSecret="$(openssl rand -base64 32)" \
    postgresAdminPassword="StrongPass123!" \
    appServiceSkuName=B1 \
    postgresSku=Standard_B1ms
```

#### 4. Verify Deployment

```bash
# Get the app URL from deployment outputs
az deployment group show \
  --resource-group aidkitty-rg \
  --name mainTemplate \
  --query properties.outputs.appUrl.value

# Test health endpoint
curl https://aidkitty-app-xxxxx.azurewebsites.net/api/health
```

---

## Docker Deployment (Non-Azure)

### Using Docker Compose

```bash
# Clone and start
git clone https://github.com/nelait/aid-kitty.git
cd aid-kitty

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Start services
docker compose up -d

# App available at http://localhost:3001
```

### Standalone Docker

```bash
# Build
docker build -t aidkitty .

# Run (requires external PostgreSQL)
docker run -d \
  --name aidkitty \
  -p 3001:3001 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/aidkitty \
  -e JWT_SECRET=your-secret-key \
  -e NODE_ENV=production \
  aidkitty
```

---

## Environment Variables

| Variable | Required | Default | Description |
|:---|:---|:---|:---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `JWT_SECRET` | Yes | — | Token signing secret (min 16 chars) |
| `PORT` | No | `3001` | Server port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `FRONTEND_URL` | No | `http://localhost:5173` | Used for OAuth redirects |
| `MICROSOFT_CLIENT_ID` | No | — | Entra ID app client ID |
| `MICROSOFT_CLIENT_SECRET` | No | — | Entra ID app client secret |
| `MICROSOFT_TENANT_ID` | No | `common` | Azure AD tenant |
| `MICROSOFT_REDIRECT_URI` | No | — | OAuth callback URL |
| `OPENAI_API_KEY` | No | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key |

---

## Post-Deployment

### Run Migrations
Migrations run automatically on app startup via `runMigrations()` in the server. For manual execution:

```bash
# Inside the container
npx drizzle-kit migrate

# Seed prompt templates
npx tsx server/seed-prompt-templates.ts
```

### Configure Microsoft SSO
1. Go to [Azure Portal](https://portal.azure.com) → search **Microsoft Entra ID** → **App registrations**
2. Click **+ New registration**
   - Name: `AID Kitty`
   - Supported account types: **Accounts in any organizational directory (Multitenant)**
   - Redirect URI: Select **Web** → `https://your-app.azurewebsites.net/api/auth/microsoft/callback`
3. Click **Register**
4. Copy **Application (client) ID** → this is `MICROSOFT_CLIENT_ID`
5. Copy **Directory (tenant) ID** → this is `MICROSOFT_TENANT_ID`
6. Go to **Certificates & secrets** → **+ New client secret** → copy the value → this is `MICROSOFT_CLIENT_SECRET`
7. Add these to App Service environment variables:
   ```bash
   az webapp config appsettings set \
     --name <app-name> \
     --resource-group <rg-name> \
     --settings \
       MICROSOFT_CLIENT_ID="<client-id>" \
       MICROSOFT_CLIENT_SECRET="<client-secret>" \
       MICROSOFT_TENANT_ID="<tenant-id>"
   ```

### Health Check
The app exposes a health endpoint:
```
GET /api/health
→ { "status": "ok", "timestamp": "...", "availableProviders": [...] }
```

App Service is configured to use this endpoint with 30-second intervals.
