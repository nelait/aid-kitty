# AID Kitty — Microsoft SSO Integration Guide

## Overview

AID Kitty supports **Microsoft Entra ID (Azure AD) SSO** for enterprise authentication. Users can sign in with their Microsoft work or personal accounts using the "Sign in with Microsoft" button on the login page.

## Architecture

```
User clicks "Sign in with Microsoft"
        ↓
Frontend redirects to → /api/auth/microsoft/login
        ↓
Server redirects to → Microsoft Entra ID OAuth2 authorize endpoint
        ↓
User authenticates with Microsoft
        ↓
Microsoft redirects to → /api/auth/microsoft/callback
        ↓
Server exchanges code for tokens → Creates/links user account → Issues JWT
        ↓
Frontend receives JWT → User is logged in
```

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|:---|:---|:---|
| `MICROSOFT_CLIENT_ID` | Application (client) ID from app registration | `6be8a38a-6e2b-4104-...` |
| `MICROSOFT_CLIENT_SECRET` | Client secret value | `0Hh8Q~~7LAl...` |
| `MICROSOFT_TENANT_ID` | Directory (tenant) ID | `9f558aa6-3506-4e75-...` |
| `MICROSOFT_REDIRECT_URI` | OAuth callback URL | `http://localhost:4000/api/auth/microsoft/callback` |

### Setting Up a New App Registration

1. Go to [Azure Portal](https://portal.azure.com) → search **Microsoft Entra ID**
2. Click **App registrations** → **+ New registration**
3. Configure:
   - **Name**: `AID Kitty`
   - **Supported account types**: Accounts in any organizational directory (Multitenant)
   - **Redirect URI**: Web → `http://localhost:4000/api/auth/microsoft/callback`
4. After registration, copy:
   - **Application (client) ID** → `MICROSOFT_CLIENT_ID`
   - **Directory (tenant) ID** → `MICROSOFT_TENANT_ID`
5. Go to **Certificates & secrets** → **+ New client secret**
   - Copy the **Value** (shown once) → `MICROSOFT_CLIENT_SECRET`

### Adding Redirect URIs

For each environment, add a redirect URI under **Authentication** → **Web**:

| Environment | Redirect URI |
|:---|:---|
| Local dev | `http://localhost:4000/api/auth/microsoft/callback` |
| Azure production | `https://your-app.azurewebsites.net/api/auth/microsoft/callback` |

## API Endpoints

| Endpoint | Method | Description |
|:---|:---|:---|
| `/api/auth/microsoft/login` | GET | Initiates Microsoft OAuth2 flow |
| `/api/auth/microsoft/callback` | GET | Handles OAuth2 callback, creates user, returns JWT |

## User Account Linking

When a user signs in with Microsoft:
1. Server checks if a user exists with the Microsoft `oid` (object ID)
2. If **not found**, checks if the email matches an existing local account
3. If **email matches**, links the Microsoft identity to the existing account
4. If **no match**, creates a new user with Microsoft credentials
5. User's `authProvider` field is set to `'microsoft'`

### Database Fields (users table)

| Column | Type | Description |
|:---|:---|:---|
| `microsoftId` | text | Microsoft user object ID (`oid` claim) |
| `tenantId` | text | Azure AD tenant ID |
| `authProvider` | text | `'local'` or `'microsoft'` |

## Troubleshooting

### AADSTS50011: Redirect URI mismatch
- **Cause**: The redirect URI in the request doesn't match what's configured in the app registration
- **Fix**: Add the exact URI to **Azure Portal** → **App registrations** → **Authentication** → **Add URI**

### AADSTS700016: Application not found
- **Cause**: Wrong `MICROSOFT_CLIENT_ID` or app deleted
- **Fix**: Verify the client ID matches the app registration

### Token exchange fails silently
- **Cause**: Client secret expired or wrong
- **Fix**: Create a new secret in **Certificates & secrets** and update `MICROSOFT_CLIENT_SECRET`

## Security Considerations

- Client secrets expire after 6/12/24 months — set a calendar reminder to rotate
- Use **Key Vault** in production to store `MICROSOFT_CLIENT_SECRET`
- The `MICROSOFT_TENANT_ID` can be set to `common` to accept any Microsoft account
- Set to a specific tenant ID to restrict to a single organization
