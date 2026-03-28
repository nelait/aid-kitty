# AID Kitty — Azure Operations Guide

## Monitoring

### Health Check

The application exposes a health endpoint that Azure App Service monitors:

```
GET /api/health
Response: { "status": "ok", "timestamp": "...", "availableProviders": [...] }
```

- **Interval**: 30 seconds
- **Timeout**: 5 seconds
- **Unhealthy threshold**: 3 consecutive failures → App Service restarts container

### Application Logs

```bash
# Stream live logs
az webapp log tail --name <app-name> --resource-group <rg-name>

# Download logs
az webapp log download --name <app-name> --resource-group <rg-name>
```

### Database Monitoring

```bash
# Check database server status
az postgres flexible-server show \
  --name <server-name> \
  --resource-group <rg-name> \
  --query "{status:state, sku:sku.name, storage:storage.storageSizeGB}"
```

---

## Backup & Recovery

### PostgreSQL Backups (Automatic)
- **Retention**: 7 days (configurable to 35)
- **Type**: Full daily + continuous WAL archiving
- **Restore**: Point-in-time recovery (any second within retention)

```bash
# Restore to a point in time
az postgres flexible-server restore \
  --source-server <server-name> \
  --restore-time "2026-03-27T10:00:00Z" \
  --name <new-server-name> \
  --resource-group <rg-name>
```

### Key Vault (Soft Delete)
- Deleted secrets recoverable for 7 days
- Purge protection can be enabled for compliance

---

## Scaling

### App Service (Vertical)

```bash
# Scale up the App Service Plan
az appservice plan update \
  --name <plan-name> \
  --resource-group <rg-name> \
  --sku S1
```

| SKU | vCPUs | RAM | Use Case |
|:---|:---|:---|:---|
| B1 | 1 | 1.75 GB | Dev/test, <10 users |
| S1 | 1 | 1.75 GB | Production, <50 users |
| P1v2 | 1 | 3.5 GB | Enterprise, <200 users |

### PostgreSQL (Vertical)

```bash
# Scale up PostgreSQL
az postgres flexible-server update \
  --name <server-name> \
  --resource-group <rg-name> \
  --sku-name Standard_B2s
```

---

## Updating the Application

### Rolling Update

```bash
# Build and push new Docker image
docker build -t your-registry.azurecr.io/aidkitty:v2.0 .
docker push your-registry.azurecr.io/aidkitty:v2.0

# Update App Service
az webapp config container set \
  --name <app-name> \
  --resource-group <rg-name> \
  --docker-custom-image-name your-registry.azurecr.io/aidkitty:v2.0

# Restart to pull new image
az webapp restart --name <app-name> --resource-group <rg-name>
```

Migrations run automatically on startup — no manual SQL needed.

### Rollback

```bash
# Roll back to previous image
az webapp config container set \
  --name <app-name> \
  --resource-group <rg-name> \
  --docker-custom-image-name your-registry.azurecr.io/aidkitty:v1.0

az webapp restart --name <app-name> --resource-group <rg-name>
```

---

## Troubleshooting

### App Not Starting

```bash
# Check container logs
az webapp log tail --name <app-name> --resource-group <rg-name>

# Common issues:
# - DATABASE_URL incorrect → check PostgreSQL server FQDN
# - Port mismatch → ensure WEBSITES_PORT=3001
# - Image pull failure → check registry credentials
```

### Database Connection Issues

```bash
# Test connectivity from App Service
az webapp ssh --name <app-name> --resource-group <rg-name>
# Inside: wget -qO- http://localhost:3001/api/health

# Verify firewall rule
az postgres flexible-server firewall-rule list \
  --name <server-name> \
  --resource-group <rg-name>
```

### Key Vault Access Denied

```bash
# Verify managed identity has Key Vault Secrets User role
az role assignment list \
  --scope /subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault-name> \
  --query "[?principalType=='ServicePrincipal']"
```

---

## Security Operations

### Rotate JWT Secret

```bash
# Update Key Vault secret
az keyvault secret set \
  --vault-name <vault-name> \
  --name jwt-secret \
  --value "$(openssl rand -base64 32)"

# Restart app to pick up new secret
az webapp restart --name <app-name> --resource-group <rg-name>
```

### Rotate Database Password

```bash
# Update PostgreSQL password
az postgres flexible-server update \
  --name <server-name> \
  --resource-group <rg-name> \
  --admin-password "NewStrongPass456!"

# Update Key Vault
az keyvault secret set \
  --vault-name <vault-name> \
  --name db-password \
  --value "NewStrongPass456!"

# Update App Service DATABASE_URL
az webapp config appsettings set \
  --name <app-name> \
  --resource-group <rg-name> \
  --settings DATABASE_URL="postgresql://aidkittyadmin:NewStrongPass456!@<server>.postgres.database.azure.com:5432/aidkitty?sslmode=require"
```

### Audit Access
```bash
# View Key Vault access logs
az monitor activity-log list \
  --resource-group <rg-name> \
  --query "[?contains(resourceId, 'vault')]" \
  --output table
```
