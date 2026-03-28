// ====================================================================
// AID Kitty — Azure Managed Application
// Deploys: App Service + PostgreSQL Flexible Server + Key Vault
// ====================================================================

@description('The name prefix for all resources')
param appName string = 'aidkitty'

@description('Location for all resources')
param location string = resourceGroup().location

@description('Admin email for the initial AID Kitty user')
param adminEmail string

@description('JWT Secret for token signing')
@secure()
param jwtSecret string

@description('App Service Plan SKU')
@allowed(['B1', 'B2', 'S1', 'S2', 'P1v2'])
param appServiceSkuName string = 'B1'

@description('PostgreSQL administrator login')
param postgresAdminLogin string = 'aidkittyadmin'

@description('PostgreSQL administrator password')
@secure()
param postgresAdminPassword string

@description('PostgreSQL SKU name')
@allowed(['Standard_B1ms', 'Standard_B2s', 'Standard_D2s_v3'])
param postgresSku string = 'Standard_B1ms'

@description('Docker image for AID Kitty (from container registry)')
param dockerImage string = 'aidkitty/aidkitty:latest'

// Optional: Microsoft Entra ID SSO
@description('Microsoft Entra ID Client ID (optional)')
param microsoftClientId string = ''

@description('Microsoft Entra ID Client Secret (optional)')
@secure()
param microsoftClientSecret string = ''

@description('Microsoft Entra ID Tenant ID (optional)')
param microsoftTenantId string = 'common'

// Optional: AI Provider keys
@description('OpenAI API Key (optional)')
@secure()
param openaiApiKey string = ''

@description('Anthropic API Key (optional)')
@secure()
param anthropicApiKey string = ''

// ====================================================================
// Variables
// ====================================================================

var uniqueSuffix = uniqueString(resourceGroup().id, appName)
var appServicePlanName = '${appName}-plan-${uniqueSuffix}'
var webAppName = '${appName}-app-${uniqueSuffix}'
var postgresServerName = '${appName}-db-${uniqueSuffix}'
var keyVaultName = '${appName}-kv-${take(uniqueSuffix, 8)}'
var databaseName = 'aidkitty'

// ====================================================================
// Key Vault — stores secrets
// ====================================================================

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    accessPolicies: []
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

resource jwtSecretKv 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'jwt-secret'
  properties: {
    value: jwtSecret
  }
}

resource dbPasswordKv 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'db-password'
  properties: {
    value: postgresAdminPassword
  }
}

// ====================================================================
// PostgreSQL Flexible Server
// ====================================================================

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: postgresServerName
  location: location
  sku: {
    name: postgresSku
    tier: postgresSku == 'Standard_B1ms' || postgresSku == 'Standard_B2s' ? 'Burstable' : 'GeneralPurpose'
  }
  properties: {
    version: '15'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow Azure services to access the database
resource postgresFirewallRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: postgresServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ====================================================================
// App Service Plan
// ====================================================================

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  kind: 'linux'
  sku: {
    name: appServiceSkuName
  }
  properties: {
    reserved: true // Linux
  }
}

// ====================================================================
// Web App (Linux Container)
// ====================================================================

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${dockerImage}'
      alwaysOn: appServiceSkuName != 'B1'
      healthCheckPath: '/api/health'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'PORT', value: '3001' }
        { name: 'WEBSITES_PORT', value: '3001' }
        { name: 'DATABASE_URL', value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgresServer.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require' }
        { name: 'JWT_SECRET', value: '@Microsoft.KeyVault(SecretUri=${jwtSecretKv.properties.secretUri})' }
        { name: 'FRONTEND_URL', value: 'https://${webAppName}.azurewebsites.net' }
        { name: 'MICROSOFT_REDIRECT_URI', value: 'https://${webAppName}.azurewebsites.net/api/auth/microsoft/callback' }
        { name: 'ADMIN_EMAIL', value: adminEmail }
        // Microsoft Entra ID
        { name: 'MICROSOFT_CLIENT_ID', value: microsoftClientId }
        { name: 'MICROSOFT_CLIENT_SECRET', value: microsoftClientSecret }
        { name: 'MICROSOFT_TENANT_ID', value: microsoftTenantId }
        // AI Provider keys
        { name: 'OPENAI_API_KEY', value: openaiApiKey }
        { name: 'ANTHROPIC_API_KEY', value: anthropicApiKey }
        // Docker settings
        { name: 'DOCKER_ENABLE_CI', value: 'true' }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
      ]
    }
  }
}

// Grant Web App access to Key Vault
resource keyVaultAccessPolicy 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, webApp.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6') // Key Vault Secrets User
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ====================================================================
// Outputs
// ====================================================================

output appUrl string = 'https://${webApp.properties.defaultHostName}'
output webAppName string = webApp.name
output keyVaultName string = keyVault.name
output postgresServerName string = postgresServer.name
output postgresServerFqdn string = postgresServer.properties.fullyQualifiedDomainName
output resourceGroupName string = resourceGroup().name

output landingPageUrl string = 'https://${webApp.properties.defaultHostName}/api/marketplace/landing'
output webhookUrl string = 'https://${webApp.properties.defaultHostName}/api/marketplace/webhook'
output microsoftRedirectUri string = 'https://${webApp.properties.defaultHostName}/api/auth/microsoft/callback'
