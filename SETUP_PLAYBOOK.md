# AID Kitty - Complete Local Setup Playbook with PostgreSQL

## Prerequisites
- Node.js 18+ installed
- Docker Desktop installed and running
- macOS (tested on macOS)

## Step 1: Clone and Install Dependencies

```bash
cd /path/to/your/projects
git clone <repository-url> aid-kitty
cd aid-kitty

# Install backend dependencies
npm install

# Install frontend dependencies
cd client
npm install
cd ..
```

## Step 2: Set Up PostgreSQL Database with Docker

```bash
# Start PostgreSQL container
docker run --name aid-kitty-postgres \
  -e POSTGRES_USER=aid_kitty_user \
  -e POSTGRES_PASSWORD=aid_kitty_password \
  -e POSTGRES_DB=aid_kitty \
  -p 5433:5432 \
  -d postgres:15

# Verify container is running
docker ps | grep aid-kitty-postgres
```

## Step 3: Configure Environment Variables

Create `.env` file in the root directory:

```bash
# Database
DATABASE_URL=postgresql://aid_kitty_user:aid_kitty_password@localhost:5433/aid_kitty

# OpenAI API Key (required for chat functionality)
OPENAI_API_KEY=your_openai_api_key_here

# JWT Secret (generate a random string)
JWT_SECRET=your_jwt_secret_here

# Node Environment
NODE_ENV=development
```

## Step 4: Run Database Migrations

The migrations will run automatically when you start the server, but ensure migration files are present:

**Critical Fix**: Comment out migration history clearing in `server/db.ts` (lines 63-64):
```typescript
// COMMENTED OUT: This was causing data loss by re-running migrations every time
// console.log('Clearing migration history to resolve schema conflicts...');
// await sql`DELETE FROM __drizzle_migrations`;
```

Migration files needed:
- `migrations/0001_postgresql_consolidated.sql` - Core tables
- `migrations/0002_add_prompt_builder_tables.sql` - Prompt Builder tables

## Step 5: Update Vite Proxy Configuration

In `client/vite.config.ts`, ensure proxy uses IPv4:

```typescript
server: {
  port: 3000,
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:3002',  // Use 127.0.0.1 instead of localhost
      changeOrigin: true,
    },
  },
},
```

## Step 6: Start the Application

**Terminal 1 - Backend:**
```bash
cd aid-kitty
npm run dev
```

Wait for:
```
✅ Migrations completed successfully
✅ AID Kitty server running on port 3002
```

**Terminal 2 - Frontend:**
```bash
cd aid-kitty/client
npm run dev
```

Wait for:
```
➜  Local:   http://localhost:3000/
```

## Step 7: Create First User

```bash
curl -X POST http://localhost:3002/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","email":"admin@example.com","password":"password123"}'
```

## Step 8: Activate API Key

After adding an OpenAI API key through the UI:

```bash
# Get the API key ID from the database
psql postgresql://aid_kitty_user:aid_kitty_password@localhost:5433/aid_kitty -c "SELECT id FROM api_keys;"

# Activate it
psql postgresql://aid_kitty_user:aid_kitty_password@localhost:5433/aid_kitty -c "UPDATE api_keys SET is_active = true WHERE id = '<api_key_id>';"
```

## Step 9: Seed Chat Templates (Optional)

```bash
npm run seed-chat-templates
```

This creates 10 useful MVP development templates:
- 🎯 MVP Idea Validation
- 🛠️ Tech Stack Recommendation
- 📋 Feature Prioritization
- 📝 User Story Generator
- 🔌 API Design Helper
- 🗄️ Database Schema Design
- 👀 Code Review Request
- 🐛 Bug Debugging Assistant
- 🔒 Security Audit Request
- ⚡ Performance Optimization

## Step 10: Seed Prompt Templates (Optional)

```bash
npm run seed-templates
```

---

## Common Issues and Solutions

### Issue 1: Data Loss on Server Restart
**Symptom**: Users/data disappear after restarting backend

**Solution**: Ensure lines 63-64 in `server/db.ts` are commented out (see Step 4)

### Issue 2: Frontend Can't Connect to Backend
**Symptom**: `ECONNREFUSED ::1:3002` errors in browser console

**Solution**: Use `127.0.0.1` instead of `localhost` in Vite config (see Step 5)

### Issue 3: API Key Not Working in Chat
**Symptom**: Chat asks to add API key even after adding

**Solution**: Activate the API key in database (see Step 8)

### Issue 4: Prompt Builder Errors
**Symptom**: 500 errors when accessing Prompt Builder

**Solution**: Ensure migration `0002_add_prompt_builder_tables.sql` has run and includes:
- All JSON columns (guidelines, standards, libraries, etc.)
- `content` column made nullable
- `prompt_builder_sessions` table created

### Issue 5: Migration Errors
**Symptom**: Foreign key or column errors during migration

**Solution**: Migrations run as single transaction. Check `server/db.ts` uses `sql.unsafe(cleanedContent)` for atomic execution

---

## Database Management Commands

```bash
# Connect to database
psql postgresql://aid_kitty_user:aid_kitty_password@localhost:5433/aid_kitty

# List all tables
\dt

# View table structure
\d table_name

# View users
SELECT id, username, email FROM users;

# View API keys
SELECT id, provider, name, is_active, user_id FROM api_keys;

# View chat templates
SELECT id, name, category FROM chat_templates;

# Exit psql
\q
```

---

## Stopping the Application

```bash
# Stop backend (Ctrl+C in Terminal 1)
# Stop frontend (Ctrl+C in Terminal 2)

# Stop PostgreSQL container
docker stop aid-kitty-postgres

# Start PostgreSQL container again later
docker start aid-kitty-postgres
```

---

## Complete Reset (Fresh Start)

```bash
# Stop and remove container
docker stop aid-kitty-postgres
docker rm aid-kitty-postgres

# Remove all data and start fresh
# Then follow Steps 2-10 again
```

---

## Tech Stack

- **Backend**: Node.js/Express (port 3002)
- **Frontend**: React/Vite (port 3000)
- **Database**: PostgreSQL 15 (port 5433)
- **ORM**: Drizzle ORM
- **AI**: OpenAI API integration

---

## Key Features Working

✅ User authentication and registration  
✅ Chat with AI using templates  
✅ Prompt Builder for creating structured prompts  
✅ API key management  
✅ PostgreSQL data persistence  
✅ Custom migration runner  
✅ Template seeding scripts

---

## Development Workflow

1. **Make changes** to backend or frontend code
2. **Backend auto-reloads** with `tsx watch`
3. **Frontend auto-reloads** with Vite HMR
4. **Database changes** require new migration files in `migrations/`
5. **Test thoroughly** before committing

---

## Project Structure

```
aid-kitty/
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── lib/          # API clients, utilities
│   │   └── pages/        # Page components
│   └── vite.config.ts    # Vite configuration
├── server/                # Express backend
│   ├── routes/           # API routes
│   ├── db.ts            # Database connection & migrations
│   ├── prompt-builder.ts # Prompt generation service
│   └── index.ts         # Server entry point
├── shared/               # Shared code
│   └── schema.ts        # Database schema (Drizzle)
├── migrations/           # SQL migration files
│   ├── 0001_postgresql_consolidated.sql
│   └── 0002_add_prompt_builder_tables.sql
├── .env                 # Environment variables (create this)
└── package.json         # Dependencies and scripts
```

---

## Available NPM Scripts

```bash
npm run dev                    # Start backend server
npm run build                  # Build frontend for production
npm run seed-chat-templates    # Seed chat templates
npm run seed-templates         # Seed prompt templates
npm run db:studio             # Open Drizzle Studio (database GUI)
```

---

## Support

For issues or questions:
1. Check the "Common Issues and Solutions" section above
2. Review the database with `psql` commands
3. Check backend logs in Terminal 1
4. Check frontend console in browser DevTools

---

**Happy Coding! 🚀**
