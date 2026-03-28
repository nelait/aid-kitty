# AID Kitty — Development Setup Guide

## Prerequisites

- **Node.js** 18+ (`node --version`)
- **PostgreSQL** 15+ (`psql --version`)
- **npm** 9+ (`npm --version`)
- *Optional:* Docker Desktop (for containerized development)

## Quick Start

```bash
# 1. Clone
git clone https://github.com/nelait/aid-kitty.git
cd aid-kitty

# 2. Install dependencies
npm install
cd client && npm install && cd ..

# 3. Configure environment
cp .env.example .env
# Edit .env with your values (see below)

# 4. Setup database
psql postgres -c "CREATE ROLE aid_kitty_user WITH LOGIN PASSWORD 'aid_kitty_password';"
psql postgres -c "CREATE DATABASE aid_kitty OWNER aid_kitty_user;"

# 5. Start development server
npm run dev
# Server runs on http://localhost:4000

# 6. Start frontend (separate terminal)
cd client && npm run dev
# Frontend runs on http://localhost:4001
```

## Environment Variables

Create a `.env` file in the project root:

```env
# Required
DATABASE_URL=postgresql://aid_kitty_user:aid_kitty_password@localhost:5432/aid_kitty
JWT_SECRET=your-secret-key-min-16-chars
PORT=4000

# AI Providers (at least one recommended)
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...
DEEPSEEK_API_KEY=sk-...

# Microsoft SSO (optional)
MICROSOFT_CLIENT_ID=your-client-id
MICROSOFT_CLIENT_SECRET=your-client-secret
MICROSOFT_TENANT_ID=your-tenant-id
MICROSOFT_REDIRECT_URI=http://localhost:4000/api/auth/microsoft/callback

# Frontend
FRONTEND_URL=http://localhost:4001
NODE_ENV=development
MAX_FILE_SIZE=10485760
UPLOAD_DIR=./uploads
```

## Project Structure

```
aid-kitty/
├── client/                  # React frontend (Vite)
│   ├── src/
│   │   ├── components/      # Reusable UI components
│   │   ├── hooks/           # Custom React hooks
│   │   ├── lib/             # Auth context, API client
│   │   ├── pages/           # Page components
│   │   └── App.tsx          # Root component + routing
│   ├── package.json
│   └── vite.config.ts       # Vite config (proxy to backend)
├── server/                  # Express.js backend
│   ├── ai/                  # AI provider integrations
│   │   └── providers.ts     # OpenAI, Anthropic, Google, DeepSeek
│   ├── marketplace/         # Microsoft AppSource integration
│   │   ├── fulfillment-api.ts
│   │   ├── landing-page.ts
│   │   └── webhook.ts
│   ├── microsoft-auth.ts    # Entra ID SSO (MSAL)
│   ├── db.ts                # Database connection + migrations
│   ├── auth.ts              # JWT auth middleware
│   └── index.ts             # Main server (all routes)
├── shared/
│   └── schema.ts            # Drizzle ORM schema (16 tables)
├── migrations/              # SQL migration files
├── azure/                   # Azure deployment templates
│   ├── mainTemplate.bicep   # ARM infrastructure
│   ├── createUiDefinition.json
│   └── scripts/deploy.sh
├── docs/                    # Documentation
├── Dockerfile               # Multi-stage Docker build
├── docker-compose.yml       # Local dev with Docker
└── drizzle.config.ts        # Drizzle ORM config
```

## Key Technologies

| Layer | Technology |
|:---|:---|
| **Frontend** | React 18, Vite, TypeScript, Shadcn/UI, TanStack Query |
| **Backend** | Express.js, TypeScript, tsx (runtime) |
| **Database** | PostgreSQL 15, Drizzle ORM |
| **Auth** | JWT (local), MSAL (Microsoft SSO) |
| **AI** | OpenAI, Anthropic, Google Gemini, DeepSeek |
| **Deployment** | Docker, Azure App Service, Railway |

## Common Commands

```bash
# Development
npm run dev                    # Start backend with hot reload
cd client && npm run dev       # Start frontend with HMR

# Database
npx drizzle-kit generate      # Generate migration from schema changes
npx drizzle-kit migrate       # Run pending migrations
npx tsx server/seed-prompt-templates.ts  # Seed default templates

# Build
cd client && npm run build     # Build frontend for production
docker build -t aidkitty .     # Build Docker image

# Docker
docker compose up -d           # Start app + PostgreSQL
docker compose down            # Stop services
docker compose logs -f app     # View app logs
```

## Branches

| Branch | Purpose |
|:---|:---|
| `main` | Stable release |
| `feature/microsoft-marketplace-app` | AppSource SaaS listing + SSO |
| `feature/azure-marketplace-managed-app` | Azure Managed App + Docker + Bicep |

## Troubleshooting

### Database connection refused
```bash
# Check if PostgreSQL is running
pg_isready -h localhost -p 5432

# Start PostgreSQL (macOS)
brew services start postgresql@15
```

### Port already in use
```bash
# Find what's using a port
lsof -i :4000

# Kill the process
kill -9 <PID>
```

### Migrations fail
```bash
# Check database exists
psql -l | grep aid_kitty

# Re-create database
psql postgres -c "DROP DATABASE aid_kitty;"
psql postgres -c "CREATE DATABASE aid_kitty OWNER aid_kitty_user;"
```

### AI providers not loading
- Ensure API keys are set in `.env` (not empty strings)
- Restart the server after changing `.env`
- Check the console for `Available providers: [...]`
