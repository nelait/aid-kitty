# AID Kitty — API Reference

## Authentication

All API endpoints (except auth routes) require a JWT token in the `Authorization` header:

```
Authorization: Bearer <jwt-token>
```

Tokens are obtained via `/api/auth/login`, `/api/auth/register`, or Microsoft SSO.

---

## Auth Endpoints

### POST `/api/auth/register`
Create a new user account.

```json
{ "email": "user@example.com", "password": "secure123", "name": "John Doe" }
```
**Response**: `{ "token": "jwt...", "user": { "id", "email", "name" } }`

### POST `/api/auth/login`
Sign in with email/password.

```json
{ "email": "user@example.com", "password": "secure123" }
```
**Response**: `{ "token": "jwt...", "user": { ... } }`

### GET `/api/auth/microsoft/login`
Initiates Microsoft SSO flow. Redirects to Microsoft login page.

### GET `/api/auth/microsoft/callback`
OAuth2 callback. Returns JWT and redirects to frontend.

### GET `/api/auth/me`
Get current authenticated user. **Requires auth.**

---

## Project Endpoints

### GET `/api/projects`
List all projects for the authenticated user. **Requires auth.**

### POST `/api/projects`
Create a new project. **Requires auth.**

```json
{ "title": "My MVP", "description": "A new app idea" }
```

### GET `/api/projects/:id`
Get a specific project. **Requires auth.**

### PUT `/api/projects/:id`
Update a project. **Requires auth.**

### DELETE `/api/projects/:id`
Delete a project. **Requires auth.**

---

## AI Generation Endpoints

### POST `/api/generate/plan`
Generate an MVP plan using AI. **Requires auth.**

```json
{
  "projectId": "project-uuid",
  "prompt": "Build a task management app",
  "provider": "openai",
  "model": "gpt-4o"
}
```

### POST `/api/generate/document`
Generate a document (PRD, spec, etc.). **Requires auth.**

```json
{
  "projectId": "project-uuid",
  "documentType": "prd",
  "prompt": "Generate a PRD for...",
  "provider": "openai"
}
```

---

## Chat Endpoints

### GET `/api/chat/sessions`
List chat sessions. **Requires auth.**

### POST `/api/chat/sessions`
Create a new chat session. **Requires auth.**

### GET `/api/chat/sessions/:id/messages`
Get messages for a session. **Requires auth.**

### POST `/api/chat/sessions/:id/messages`
Send a message and get AI response. **Requires auth.**

```json
{
  "content": "How should I structure my database?",
  "provider": "openai",
  "model": "gpt-4o"
}
```

---

## Settings Endpoints

### GET `/api/api-keys`
List stored API keys (masked). **Requires auth.**

### POST `/api/api-keys`
Store an AI provider API key. **Requires auth.**

```json
{ "provider": "openai", "apiKey": "sk-proj-..." }
```

### DELETE `/api/api-keys/:id`
Delete a stored API key. **Requires auth.**

---

## File Upload Endpoints

### POST `/api/upload`
Upload a file to a project. **Requires auth.** Uses `multipart/form-data`.

### GET `/api/files/:projectId`
List files for a project. **Requires auth.**

### DELETE `/api/files/:id`
Delete an uploaded file. **Requires auth.**

---

## Health & System

### GET `/api/health`
Health check endpoint. **No auth required.**

```json
{
  "status": "ok",
  "timestamp": "2026-03-28T22:34:57.217Z",
  "availableProviders": ["openai"]
}
```

---

## Error Responses

All errors follow this format:

```json
{ "error": "Error message describing the issue" }
```

| Status Code | Meaning |
|:---|:---|
| `400` | Bad request — missing or invalid parameters |
| `401` | Unauthorized — missing or invalid JWT token |
| `403` | Forbidden — user doesn't have permission |
| `404` | Not found — resource doesn't exist |
| `500` | Internal server error — unexpected failure |
