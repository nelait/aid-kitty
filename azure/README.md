# AID Kitty — Azure Managed Application Deployment

## Overview

This directory contains everything needed to deploy AID Kitty as an **Azure Managed Application** into a customer's Azure subscription.

## Architecture

```
Customer's Azure Subscription
├── Resource Group (managed)
│   ├── App Service (Linux Container)
│   │   └── AID Kitty Docker image
│   ├── Azure Database for PostgreSQL Flexible Server
│   │   └── aidkitty database
│   └── Azure Key Vault
│       ├── jwt-secret
│       └── db-password
└── App Service Plan (B1/S1/P1v2)
```

## Files

| File | Purpose |
|:---|:---|
| `mainTemplate.bicep` | Infrastructure template (Bicep source) |
| `mainTemplate.json` | Compiled ARM template (for marketplace) |
| `createUiDefinition.json` | Azure Portal deployment wizard |
| `scripts/deploy.sh` | Post-deployment migration script |

## Local Development with Docker

```bash
# Build and run locally
docker compose up --build

# App will be at http://localhost:3001
```

## Building the Marketplace Package

```bash
# 1. Compile Bicep to ARM JSON
az bicep build --file mainTemplate.bicep --outfile mainTemplate.json

# 2. Validate with ARM Template Test Toolkit
Test-AzTemplate -TemplatePath ./mainTemplate.json

# 3. Package for submission
zip -j aidkitty-managed-app.zip mainTemplate.json createUiDefinition.json
```

## Deployment Parameters

| Parameter | Required | Default | Description |
|:---|:---|:---|:---|
| `appName` | Yes | `aidkitty` | Resource name prefix |
| `adminEmail` | Yes | — | Initial admin email |
| `jwtSecret` | Yes | — | Token signing secret |
| `postgresAdminPassword` | Yes | — | Database password |
| `appServiceSkuName` | No | `B1` | App Service compute size |
| `postgresSku` | No | `Standard_B1ms` | Database compute size |
| `microsoftClientId` | No | — | Entra ID SSO client |
| `openaiApiKey` | No | — | OpenAI API key |

## Cost Estimates (Monthly)

| SKU Tier | App Service | PostgreSQL | Total ~USD |
|:---|:---|:---|:---|
| Dev/Test | B1 ($13) | B1ms ($13) | **~$26/mo** |
| Production | S1 ($69) | B2s ($26) | **~$95/mo** |
| Enterprise | P1v2 ($138) | D2s_v3 ($100) | **~$238/mo** |
