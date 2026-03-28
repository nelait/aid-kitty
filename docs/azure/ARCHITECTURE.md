# AID Kitty — Azure Architecture

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Customer's Azure Subscription                │
│                                                                 │
│  ┌──────────────────────┐     ┌──────────────────────────┐     │
│  │  App Service Plan     │     │  Key Vault               │     │
│  │  (Linux, B1/S1/P1v2) │     │  ├── jwt-secret          │     │
│  │                       │     │  └── db-password          │     │
│  │  ┌─────────────────┐ │     └──────────┬───────────────┘     │
│  │  │ App Service      │ │                │                     │
│  │  │ (Docker)         │◄├────────────────┘                     │
│  │  │                  │ │   Key Vault ref via                  │
│  │  │  ┌────────────┐  │ │   managed identity                  │
│  │  │  │ Express.js │  │ │                                      │
│  │  │  │ Server     │  │ │                                      │
│  │  │  ├────────────┤  │ │                                      │
│  │  │  │ React SPA  │  │ │                                      │
│  │  │  │ (static)   │  │ │                                      │
│  │  │  └────────────┘  │ │                                      │
│  │  └────────┬─────────┘ │                                      │
│  └───────────┼───────────┘                                      │
│              │ DATABASE_URL (SSL)                                │
│  ┌───────────▼───────────────────────────┐                      │
│  │  PostgreSQL Flexible Server (v15)     │                      │
│  │  ├── Database: aidkitty               │                      │
│  │  ├── Storage: 32 GB                   │                      │
│  │  ├── Backup: 7 days retention         │                      │
│  │  └── Firewall: Azure services only    │                      │
│  └───────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘

External Services (Customer-provided API keys)
┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐
│  OpenAI   │ │ Anthropic │ │  Google   │ │ DeepSeek  │
│  GPT-4    │ │  Claude   │ │  Gemini   │ │           │
└───────────┘ └───────────┘ └───────────┘ └───────────┘
```

## Resource Details

### App Service

| Setting | Value |
|:---|:---|
| OS | Linux |
| Runtime | Docker container (Node 18 alpine) |
| HTTPS | Enforced |
| Health Check | `/api/health` every 30s |
| Managed Identity | System-assigned (Key Vault access) |
| Always On | Enabled (S1+ SKUs) |

### PostgreSQL Flexible Server

| Setting | Value |
|:---|:---|
| Version | PostgreSQL 15 |
| Storage | 32 GB (auto-grow available) |
| Backup | 7-day retention |
| HA | Disabled (enable for production) |
| SSL | Required for all connections |
| Firewall | Azure services only (0.0.0.0/0 rule) |

### Key Vault

| Setting | Value |
|:---|:---|
| SKU | Standard |
| Access | RBAC authorization |
| Soft Delete | Enabled (7 days) |
| Secrets | jwt-secret, db-password |

## Database Schema

16 tables managed by Drizzle ORM with automatic migrations:

| Table | Purpose |
|:---|:---|
| `users` | User accounts (local + Microsoft SSO) |
| `projects` | MVP projects created by users |
| `generated_plans` | AI-generated MVP plans |
| `generated_documents` | AI-generated documents (PRD, specs, etc.) |
| `chat_messages` | AI chat conversation history |
| `chat_sessions` | Chat session metadata |
| `chat_templates` | Reusable prompt templates |
| `api_keys` | User-stored AI provider API keys |
| `file_uploads` | Uploaded project files |
| `estimation_settings` | Function point estimation configs |
| `prompt_builder_sessions` | Prompt builder session data |
| `prompt_templates` | System prompt templates |
| `github_settings` | GitHub integration config |
| `openhands_settings` | OpenHands integration config |
| `openhands_builds` | OpenHands build tracking |
| `subscriptions` | Marketplace subscription records |

## Security Model

### Authentication
- **Local**: Email/password with bcrypt (12 rounds) + JWT (7-day expiry)
- **Microsoft SSO**: Entra ID OAuth2 code flow via MSAL
- **Marketplace**: Auto-provisioning from AppSource purchase flow

### Data Protection
- All secrets in **Azure Key Vault** (not in environment variables)
- Database connections require **SSL**
- **HTTPS enforced** on App Service
- API keys stored with **encryption**
- No data shared with third parties (AI calls use customer's own API keys)

### Network
- PostgreSQL accessible only from **Azure services** (firewall rule)
- No public database endpoint
- App Service uses **managed identity** for Key Vault (no credentials stored)

## Scaling

| Component | Scale Strategy |
|:---|:---|
| App Service | Vertical: B1 → S1 → P1v2. Horizontal: Scale out in App Service Plan |
| PostgreSQL | Vertical: B1ms → B2s → D2s_v3. Storage auto-grow |
| Key Vault | No scaling needed (1000 TPS included) |

## Cost Summary

| Tier | App Service | PostgreSQL | Key Vault | Total |
|:---|:---|:---|:---|:---|
| **Dev/Test** | B1 ($13) | B1ms ($13) | Free tier | **~$26/mo** |
| **Production** | S1 ($69) | B2s ($26) | ~$1 | **~$96/mo** |
| **Enterprise** | P1v2 ($138) | D2s_v3 ($100) | ~$1 | **~$239/mo** |

*Prices approximate, USD, East US region. Actual costs vary by usage.*
