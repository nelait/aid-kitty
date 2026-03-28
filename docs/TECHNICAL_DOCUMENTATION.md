# AID Kitty — Complete Technical Documentation

AID Kitty is a professional-grade, AI-powered platform for generating MVP plans, project documentation, and providing contextual chat capabilities for software development projects. It automates the early stages of project scoping by combining multi-LLM AI generation with structured prompt engineering, project estimation, and CI/CD integration via GitHub and OpenHands.

---

## 1. System Architecture

```mermaid
graph TD
    subgraph Client["Frontend (React + Vite)"]
        A[React SPA] --> B[Wouter Router]
        A --> C[TanStack Query]
        A --> D[AuthContext]
        A --> E[Axios API Client]
    end

    subgraph Server["Backend (Express + TypeScript)"]
        F[Express Server] --> G[Auth Middleware]
        F --> H[AI Service Layer]
        F --> I[GitHub Service]
        F --> J[OpenHands Service]
        F --> K[File Processor]
        F --> L[Prompt Builder]
    end

    subgraph AI["AI Providers"]
        H --> M[OpenAI]
        H --> N[Anthropic]
        H --> O[Google Gemini]
        H --> P[DeepSeek]
    end

    subgraph DB["Database"]
        Q[(PostgreSQL)]
    end

    E -->|"/api/*"| F
    F --> Q
    I -->|REST| R[GitHub API]
    J -->|REST| S[OpenHands Cloud]
```

### Technology Stack

| Layer | Technology | Details |
|:---|:---|:---|
| **Frontend** | React 18 + TypeScript | SPA with Vite dev server |
| **Routing** | [wouter](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/App.tsx) | Lightweight React router (3.0) |
| **State/Data** | TanStack React Query 5 | Server state management with retry & caching |
| **Styling** | Tailwind CSS 3 + Radix UI | Component primitives from Radix, utility-first CSS |
| **Backend** | Node.js + Express 4 | TypeScript, ESM modules (`"type": "module"`) |
| **ORM** | Drizzle ORM 0.39 | Type-safe SQL with PostgreSQL driver |
| **Database** | PostgreSQL | Connection via `pg` Pool |
| **Auth** | JWT + bcrypt | 7-day tokens, 12-round bcrypt salt |
| **AI SDKs** | OpenAI, Anthropic, Google GenAI | Plus DeepSeek (OpenAI-compatible API) |
| **Runtime** | Node ≥ 18 | `tsx watch` for dev hot-reload |

---

## 2. Repository Structure

```
aid-kitty/
├── client/                  # React frontend
│   ├── src/
│   │   ├── App.tsx              # Root component & route definitions
│   │   ├── main.tsx             # Vite entry point
│   │   ├── index.css            # Global styles
│   │   ├── pages/               # 11 page components
│   │   ├── components/          # 7 feature components + 11 UI primitives
│   │   ├── hooks/               # Custom hooks (use-toast)
│   │   └── lib/                 # API client, auth context, utilities
│   ├── vite.config.ts           # Vite config (port 5173 → proxy to 3002)
│   ├── tailwind.config.js       # Tailwind theme config
│   └── package.json             # Client dependencies
├── server/                  # Express backend
│   ├── index.ts                 # 1730-line main server (all routes)
│   ├── auth.ts                  # AuthService + JWT middleware
│   ├── db.ts                    # PostgreSQL pool + Drizzle + migrations
│   ├── prompt-builder.ts        # PromptBuilderService (628 lines)
│   ├── github-service.ts        # GitHub API integration
│   ├── openhands.ts             # OpenHands Cloud API integration
│   ├── seed-prompt-templates.ts # Default template seeder
│   ├── ai/                      # AI service layer
│   │   ├── providers.ts             # AIProvider interface + 4 implementations
│   │   ├── mvp-generator.ts         # MVPGenerator (5 plan types)
│   │   ├── document-generator.ts    # DocumentGenerator (7 doc types, 799 lines)
│   │   └── chat-service.ts          # ChatService (conversational AI)
│   ├── routes/
│   │   └── prompt-builder.ts    # Prompt builder sub-routes
│   └── utils/
│       └── file-processor.ts    # File upload + PDF text extraction
├── shared/                  # Shared code between client & server
│   └── schema.ts                # Drizzle schema (15 tables, 381 lines)
├── migrations/              # Drizzle-generated SQL migrations
├── data/                    # Database storage
├── uploads/                 # Uploaded files directory
├── drizzle.config.ts        # Drizzle Kit configuration
├── package.json             # Root dependencies & scripts
├── tsconfig.json            # TypeScript configuration
├── railway.json             # Railway deployment config
└── nixpacks.toml            # Nixpacks build config
```

---

## 3. Database Schema

The application uses **PostgreSQL** with **Drizzle ORM**. All table definitions are in [schema.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/shared/schema.ts). IDs are generated using `@paralleldrive/cuid2`.

### 3.1 Entity Relationship Diagram

```mermaid
erDiagram
    users ||--o{ projects : "owns"
    users ||--o{ apiKeys : "stores"
    users ||--o{ chatSessions : "creates"
    users ||--o{ chatMessages : "sends"
    users ||--o{ chatTemplates : "creates"
    users ||--o{ githubSettings : "configures"
    users ||--o{ openhandsSettings : "configures"
    users ||--o{ openhandsBuilds : "triggers"
    users ||--o{ estimationSettings : "configures"
    users ||--o{ promptTemplates : "creates"
    users ||--o{ promptBuilderSessions : "generates"
    projects ||--o{ generatedPlans : "has"
    projects ||--o{ generatedDocuments : "has"
    projects ||--o{ fileUploads : "has"
    projects ||--o{ chatMessages : "scoped to"
    promptTemplates ||--o{ promptBuilderSessions : "used in"
```

### 3.2 Table Definitions

| Table | Purpose | Key Columns |
|:---|:---|:---|
| **users** | User accounts | `id`, `username` (unique), `email` (unique), `passwordHash` |
| **projects** | User projects | `userId` (FK), `title`, `requirements`, `status` (draft/processing/completed/failed) |
| **generatedPlans** | AI-generated MVP plans | `projectId` (FK), `model`, `planType`, `content`, `tokensUsed`, `generationTime` |
| **generatedDocuments** | AI-generated documents | `projectId` (FK), `model`, `documentType` (7 types), `content` |
| **fileUploads** | Uploaded files | `projectId` (FK), `filename`, `mimeType`, `extractedText`, `uploadPath` |
| **apiKeys** | User-provided AI keys | `userId` (FK), `provider`, `key`, `isActive` |
| **chatSessions** | Chat session metadata | `projectId` (FK), `userId` (FK), `title`, `model` |
| **chatMessages** | Chat history | `userId` (FK), `projectId` (FK), `provider`, `role`, `content`, `metadata` |
| **chatTemplates** | Reusable chat prompts | `userId` (FK), `name`, `content`, `category` (6 types), `tags`, `isPublic` |
| **githubSettings** | GitHub PAT config | `userId` (FK), `accessToken`, `username`, `defaultRepo`, `defaultBranch` |
| **openhandsSettings** | OpenHands API config | `userId` (FK), `apiKey`, `defaultRepo` |
| **openhandsBuilds** | Build/conversation tracking | `userId` (FK), `conversationId`, `repository`, `prompt`, `status` |
| **estimationSettings** | FPA estimation profiles | `userId` (FK), `complexityWeights` (JSON), `functionTypes` (JSON), `environmentalFactors` (JSON), `projectParameters` (JSON) |
| **promptTemplates** | Prompt builder templates | `userId` (FK), `applicationType` (14 types), `category` (9 types), architecture/security/testing config (JSON) |
| **promptBuilderSessions** | Generated prompt records | `userId` (FK), `templateId` (FK), `projectDescription`, `selectedFeatures`, `generatedPrompt` |

> [!NOTE]
> All tables use `text` primary keys with CUID2 generation. Foreign keys have `onDelete: 'cascade'` for referential integrity.

---

## 4. Authentication System

Defined in [auth.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/auth.ts).

### Flow

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant DB

    Client->>Server: POST /api/auth/register {username, email, password}
    Server->>Server: bcrypt.hash(password, 12 rounds)
    Server->>DB: INSERT into users
    Server-->>Client: 201 Created

    Client->>Server: POST /api/auth/login {email, password}
    Server->>DB: SELECT user by email
    Server->>Server: bcrypt.compare(password, hash)
    Server->>Server: jwt.sign({id, username, email}, secret, {expiresIn: '7d'})
    Server-->>Client: {token, user}

    Client->>Client: localStorage.setItem('token', token)

    Client->>Server: GET /api/auth/me [Authorization: Bearer <token>]
    Server->>Server: jwt.verify(token)
    Server->>DB: SELECT user by decoded.id
    Server-->>Client: {user}
```

### Key Implementation Details

- **JWT secret**: `process.env.SESSION_SECRET` (fallback: `'your-secret-key'`)
- **Token expiry**: 7 days
- **Password hashing**: bcrypt with 12 salt rounds
- **Middleware**: `authenticateToken` — extracts Bearer token, verifies JWT, attaches `req.user`
- **Optional auth**: `optionalAuth` — same as above but doesn't fail when no token is present
- **Client-side**: [auth-context.tsx](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/lib/auth-context.tsx) provides `AuthProvider` with `login`, `register`, `logout`, `loading`
- **401 handling**: Axios response interceptor clears token and redirects to `/login`

---

## 5. AI Service Layer

### 5.1 Provider Architecture

Defined in [providers.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/ai/providers.ts). Uses a **Strategy + Factory** pattern.

```mermaid
classDiagram
    class AIProvider {
        <<interface>>
        +name: string
        +generateText(prompt, options) Promise~string~
        +estimateTokens(text) number
    }

    class AIProviderFactory {
        -providers: Map~string, AIProvider~
        +addProvider(name, provider)
        +getProvider(name) AIProvider
        +generateWithProvider(name, prompt, options) GenerationResult
        +getAvailableProviders() string[]
    }

    AIProvider <|.. OpenAIProvider
    AIProvider <|.. AnthropicProvider
    AIProvider <|.. GoogleProvider
    AIProvider <|.. DeepSeekProvider
    AIProviderFactory o-- AIProvider
```

| Provider | Default Model | SDK | Base URL |
|:---|:---|:---|:---|
| **OpenAI** | `gpt-4o` | `openai` | Default |
| **Anthropic** | `claude-3-5-sonnet-20241022` | `@anthropic-ai/sdk` | Default |
| **Google** | `gemini-2.0-flash-exp` | `@google/generative-ai` | Default |
| **DeepSeek** | `deepseek-chat` | `openai` (compatible) | `https://api.deepseek.com` |

Default generation parameters: `maxTokens: 4000`, `temperature: 0.7`. Token estimation uses `~4 chars/token`.

### 5.2 MVP Generator

[mvp-generator.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/ai/mvp-generator.ts) — Generates structured MVP plans.

**5 Plan Types:**

| Plan Type | Max Tokens | Description |
|:---|:---|:---|
| `executive_summary` | 4000 | Problem statement, value proposition, key success factors |
| `technical_spec` | 4000 | Tech stack rationale, API structure, security, performance |
| `architecture` | 4000 | System diagrams, component breakdown, scalability |
| `implementation` | 4000 | Sprint breakdown, resource allocation, testing strategy |
| `full_mvp` | 6000 | Comprehensive plan combining all sections above |

Also supports `generateMultiProviderComparison()` — runs the same prompt across all available providers concurrently for side-by-side comparison.

### 5.3 Document Generator

[document-generator.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/ai/document-generator.ts) — Generates project documentation (799 lines).

**7 Document Types:** `prd`, `requirements`, `techstack`, `frontend`, `backend`, `flow`, `status`

Key methods:
- `generateDocument()` — Single document generation
- `generateAllDocuments()` — All 7 types sequentially
- `generateDocumentBatch()` — Selective batch generation from a list of types
- `buildPrompt()` — 630-line method with type-specific prompts, supports estimation settings injection

### 5.4 Chat Service

[chat-service.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/ai/chat-service.ts) — Conversational AI assistant.

- System prompt defines "AID Kitty" persona specializing in MVP development
- Supports structured multi-step processes (coaching flows, frameworks)
- Injects last 50 messages as conversation history
- `maxTokens: 2000`, `temperature: 0.7`

---

## 6. API Reference

All routes are defined in [server/index.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/index.ts). All authenticated endpoints use `authenticateToken` middleware.

### 6.1 Authentication

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `POST` | `/api/auth/register` | ❌ | Register: `{username, email, password}` |
| `POST` | `/api/auth/login` | ❌ | Login: `{email, password}` → `{token, user}` |
| `GET` | `/api/auth/me` | ✅ | Get current user |

### 6.2 Projects

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `GET` | `/api/projects` | ✅ | List user's projects |
| `POST` | `/api/projects` | ✅ | Create project: `{title, description, requirements}` |
| `GET` | `/api/projects/:id/plans` | ✅ | List plans for a project |
| `GET` | `/api/projects/:projectId/documents` | ✅ | List documents for a project |

### 6.3 AI Generation

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `POST` | `/api/generate-mvp` | ✅ | Generate MVP plan: `{projectId, requirements, projectTitle, provider, planType}` |
| `POST` | `/api/generate-document` | ✅ | Generate single doc: `{projectId, requirements, projectTitle, provider, documentType}` |
| `POST` | `/api/generate-documents-batch` | ✅ | Batch generation: `{...same, documentTypes[]}` |
| `PUT` | `/api/documents/:id` | ✅ | Update document content |

### 6.4 Chat

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `GET` | `/api/chat/messages` | ✅ | Get messages (optional `?projectId=`) |
| `POST` | `/api/chat/messages` | ✅ | Send message: `{content, provider, projectId?}` → `{userMessage, aiMessage}` |
| `DELETE` | `/api/chat/messages` | ✅ | Clear chat history |
| `GET` | `/api/chat/templates` | ✅ | List templates (optional `?category=`) |
| `POST` | `/api/chat/templates` | ✅ | Create template |
| `PUT` | `/api/chat/templates/:id` | ✅ | Update template |
| `DELETE` | `/api/chat/templates/:id` | ✅ | Delete template |

### 6.5 API Keys

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `GET` | `/api/api-keys` | ✅ | List user's API keys |
| `POST` | `/api/api-keys` | ✅ | Store API key: `{provider, name, key}` |
| `DELETE` | `/api/api-keys/:id` | ✅ | Delete an API key |

### 6.6 Estimation Settings

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `GET` | `/api/estimation-settings` | ✅ | List settings profiles |
| `POST` | `/api/estimation-settings` | ✅ | Create profile (FPA config) |
| `PUT` | `/api/estimation-settings/:id` | ✅ | Update profile |
| `DELETE` | `/api/estimation-settings/:id` | ✅ | Delete profile |

### 6.7 GitHub Integration

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `GET` | `/api/github/settings` | ✅ | Get GitHub PAT settings |
| `POST` | `/api/github/connect` | ✅ | Connect GitHub: validates PAT, saves settings |
| `DELETE` | `/api/github/disconnect` | ✅ | Remove GitHub connection |
| `GET` | `/api/github/repos` | ✅ | List user's GitHub repos |
| `GET` | `/api/github/branches/:owner/:repo` | ✅ | List branches for a repo |
| `POST` | `/api/github/push` | ✅ | Push documents to GitHub repo |
| `POST` | `/api/github/push-prompts` | ✅ | Push prompt sessions to GitHub |
| `POST` | `/api/github/push-templates` | ✅ | Push prompt templates to GitHub |

### 6.8 OpenHands Integration

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `GET` | `/api/openhands/settings` | ✅ | Get OpenHands settings |
| `POST` | `/api/openhands/settings` | ✅ | Save/update OpenHands API key |

### 6.9 File Upload

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `POST` | `/api/upload` | ✅ | Upload file (multer): PDF/TXT/MD, extracts text |

### 6.10 Health & Info

| Method | Endpoint | Auth | Description |
|:---|:---|:---|:---|
| `GET` | `/api/health` | ❌ | Health check with available providers |
| `GET` | `/` | ❌ | API docs (dev only) |

---

## 7. Frontend Architecture

### 7.1 Client Routing

Defined in [App.tsx](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/App.tsx) using **wouter**.

| Route | Component | Description |
|:---|:---|:---|
| `/login` | `LoginPage` | Email/password sign-in |
| `/register` | `RegisterPage` | User registration |
| `/` | `DashboardPage` | Main dashboard |
| `/dashboard` | `DashboardPage` | Dashboard alias |
| `/generate` | `GeneratePage` | AI generation interface |
| `/projects` | `ProjectsListPage` | All projects list |
| `/projects/:projectId` | `ProjectsPage` | Single project view |
| `/projects/:projectId/documents` | `ProjectDocumentsPage` | Project documents viewer |
| `/settings` | `ApiKeySettings` | API key management |
| `/estimation-settings` | `EstimationSettingsPage` | FPA estimation profiles |
| `/prompt-builder` | `PromptBuilderPage` | Prompt template builder (141KB — largest component) |
| `/chat` | `Chat` | AI chat interface |

### 7.2 Key Components

| Component | File Size | Purpose |
|:---|:---|:---|
| [PromptBuilderPage](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/pages/PromptBuilderPage.tsx) | 141KB | Comprehensive prompt template builder with 14 application types |
| [Chat](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/components/Chat.tsx) | 30KB | Full chat interface with template support & history |
| [ProjectDocumentsPage](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/pages/ProjectDocumentsPage.tsx) | 25KB | Document viewer with edit, regenerate, and GitHub push |
| [EstimationSettingsPage](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/pages/EstimationSettingsPage.tsx) | 20KB | Function Point Analysis configuration UI |
| [DocumentGenerator](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/components/DocumentGenerator.tsx) | 17KB | Document generation controls & batch UI |
| [ApiKeySettings](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/components/ApiKeySettings.tsx) | 15KB | Multi-provider API key management |
| [Navbar](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/components/Navbar.tsx) | 11KB | Navigation bar with user menu |
| [MermaidRenderer](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/components/MermaidRenderer.tsx) | 5KB | Renders Mermaid diagrams in generated content |

### 7.3 UI Component Library

11 Radix UI-based primitives in `client/src/components/ui/`:

`badge`, `button`, `card`, `dialog`, `input`, `label`, `select`, `textarea`, `toast`, `toaster`, `tooltip`

Styled with `class-variance-authority` (CVA) and `tailwind-merge`.

### 7.4 API Client

[api.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/lib/api.ts) — Axios-based client with 10 API namespaces:

- `authAPI` — login, register, me
- `projectsAPI` — list, create, getPlans
- `mvpAPI` — generate, getProviders
- `filesAPI` — upload
- `apiKeysAPI` — getAll, create, delete, update
- `chatAPI` — getMessages, sendMessage, clearHistory, deleteMessage
- `chatTemplatesAPI` — list, create, update, delete
- `documentsAPI` — generate, generateBatch, getProjectDocuments, updateDocument
- `estimationSettingsAPI` — list, create, update, delete
- `githubAPI` — getSettings, connect, disconnect, listRepos, listBranches, push, pushPrompts, pushTemplates

---

## 8. External Integrations

### 8.1 GitHub Service

[github-service.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/github-service.ts) — Manages GitHub repository interactions via PAT.

**Capabilities:**
- Validate PAT and retrieve authenticated username
- List accessible repositories (owner + collaborator, sorted by updated, max 100)
- List branches for a specific repository
- Create or update individual files (auto-detects existing files via SHA)
- Batch push multiple files sequentially
- Content is Base64-encoded before push

### 8.2 OpenHands Service

[openhands.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/openhands.ts) — Triggers AI agent builds on OpenHands Cloud.

**Capabilities:**
- Parse GitHub repository URLs into `owner/repo` format
- Start conversations (agent builds) with a prompt targeting a repository
- Poll conversation status (status, runtime status, timestamps)
- Validate API keys
- Generate dashboard URLs for conversation tracking

---

## 9. Prompt Builder System

The Prompt Builder is the most complex feature, spanning both frontend and backend.

### Backend: [prompt-builder.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/prompt-builder.ts) (628 lines)

`PromptBuilderService` generates comprehensive coding prompts from templates. It assembles sections including:

- **Header** — Application type, category, project context
- **Project Overview** — Description + selected features
- **Architecture** — Pattern, directory structure, data flow, state management, API design
- **Guidelines** — Prioritized development guidelines
- **Standards** — Coding standards with rules & examples
- **Libraries** — Required libraries with versions & alternatives
- **Security** — Threat analysis with mitigation strategies
- **Performance** — Optimization strategies with metrics
- **Best Practices** — Categorized implementation practices
- **Testing** — Framework-specific test strategies with coverage targets
- **Deployment** — Platform configs with monitoring
- **Precautions** — Severity-graded warnings with prevention steps
- **Custom Sections** — User-defined text, lists, code, or checklists
- **Attached Documents** — Inline summaries from generated project documents

### Frontend: [PromptBuilderPage.tsx](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/client/src/pages/PromptBuilderPage.tsx) (141KB)

Supports **14 application types**: web, mobile, RAG, API, desktop, ML, blockchain, IoT, game, CLI, microservice, Chrome extension, Electron, PWA

And **9 categories**: frontend, backend, fullstack, AI, data, devops, security, testing, infrastructure

---

## 10. File Processing

[file-processor.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/utils/file-processor.ts) — Handles file uploads via **multer** (in-memory storage).

| Feature | Detail |
|:---|:---|
| **Supported types** | `application/pdf`, `text/plain`, `text/markdown` |
| **Max file size** | 10MB (configurable via `MAX_FILE_SIZE`) |
| **PDF extraction** | `pdf-parse` library for text extraction |
| **Text extraction** | Direct UTF-8 buffer read |
| **Storage** | Files saved to `./uploads/` with UUID filenames |
| **Cleanup** | `cleanupOldFiles()` removes files older than 24 hours |

---

## 11. Migrations & Database Management

### Configuration

[drizzle.config.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/drizzle.config.ts):
- Schema source: `./shared/schema.ts`
- Output: `./migrations/`
- Dialect: `postgresql`
- Default connection: `postgresql://postgres:postgres@localhost:5432/aidkitty`

### Migration Runner

[db.ts](file:///Users/krishnakollepara/AntiGravityProjects/aidkitty/aid-kitty/server/db.ts) uses Drizzle's built-in PostgreSQL migrator:
- Runs automatically on server startup
- Gracefully handles: missing migrations folder, already-applied migrations
- Logs connection info with password redaction

### Migration Commands

| Command | Purpose |
|:---|:---|
| `npm run db:generate` | Generate migrations from schema changes |
| `npm run db:migrate` | Run pending migrations |
| `npm run db:studio` | Open Drizzle Studio GUI |
| `npm run db:push` | Push schema directly (bypasses migrations) |

---

## 12. Development & Operations

### Development Commands

| Command | Description |
|:---|:---|
| `npm run dev` | Start backend with `tsx watch` (hot-reload) |
| `cd client && npm run dev` | Start Vite dev server |
| `npm run build` | Build both frontend and backend |
| `npm run build:railway` | Railway-specific build (unified serving) |
| `npm run seed-templates` | Seed default prompt templates |

### Port Configuration

| Service | Port |
|:---|:---|
| Vite dev server | **5173** |
| Express backend | **3002** |
| Proxy target | Vite proxies `/api/*` → `http://localhost:3002` |

### Environment Variables

| Variable | Required | Description |
|:---|:---|:---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `SESSION_SECRET` | ✅ | JWT signing secret |
| `OPENAI_API_KEY` | ≥1 required | OpenAI API key |
| `ANTHROPIC_API_KEY` | Optional | Anthropic API key |
| `GOOGLE_API_KEY` | Optional | Google Gemini API key |
| `DEEPSEEK_API_KEY` | Optional | DeepSeek API key |
| `UPLOAD_DIR` | Optional | File upload directory (default: `./uploads`) |
| `MAX_FILE_SIZE` | Optional | Max upload size in bytes (default: 10485760) |
| `NODE_ENV` | Optional | `production` disables dev-only routes |

> [!IMPORTANT]
> At least one AI provider API key must be valid and non-placeholder, or the server will throw an error on startup.

### Deployment

- **Railway**: Configured via `railway.json` and `nixpacks.toml`
- **Build**: `npm run build:railway` compiles backend, builds frontend, and copies `client/dist` into `dist/client/` for unified static serving
- **Database**: Must persist the PostgreSQL database across deployments (e.g., Railway managed database or external PostgreSQL)

### Troubleshooting

| Issue | Resolution |
|:---|:---|
| Port conflict (EADDRINUSE) | `lsof -ti:<port> \| xargs kill -9 2>/dev/null` |
| 401 on MVP generation | Check AI provider API key in `.env` is valid (not a placeholder) |
| Proxy 404 errors | Verify backend is running on correct port (3002) |
| `.env` changes not picked up | Restart `tsx watch` manually (CTRL+C → `npm run dev`) |
| Migrations fail | Check `DATABASE_URL` is correct; ensure PostgreSQL is running |

---

## 13. Dependencies Summary

### Backend (Root `package.json`)

| Category | Packages |
|:---|:---|
| **AI SDKs** | `openai`, `@anthropic-ai/sdk`, `@google/generative-ai` |
| **Server** | `express`, `cors`, `cookie-parser`, `multer`, `dotenv` |
| **Database** | `drizzle-orm`, `pg` |
| **Auth** | `bcrypt`, `jsonwebtoken` |
| **Validation** | `zod`, `zod-validation-error`, `drizzle-zod` |
| **Utilities** | `axios`, `uuid`, `@paralleldrive/cuid2`, `pdf-parse` |
| **Dev** | `tsx`, `typescript`, `drizzle-kit`, `esbuild` |

### Frontend (`client/package.json`)

| Category | Packages |
|:---|:---|
| **Core** | `react`, `react-dom` |
| **Routing** | `wouter` |
| **Data** | `@tanstack/react-query`, `axios` |
| **UI Primitives** | `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-select`, `@radix-ui/react-toast`, `@radix-ui/react-tooltip`, `@radix-ui/react-label`, `@radix-ui/react-slot` |
| **Styling** | `tailwindcss`, `tailwind-merge`, `clsx`, `class-variance-authority`, `tailwindcss-animate` |
| **Forms** | `react-hook-form` |
| **Icons** | `lucide-react` |
| **Diagrams** | `mermaid` |
| **Dev** | `vite`, `@vitejs/plugin-react`, `typescript`, `postcss`, `autoprefixer`, `eslint` |
