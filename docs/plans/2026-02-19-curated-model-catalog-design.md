# Curated Model Catalog with Local Detection

**Date:** 2026-02-19
**Status:** Approved

## Goal

Replace the agent's unfiltered pi-ai model dump with a server-curated model catalog managed by site admins, plus auto-detection of local models (Ollama, LM Studio).

## Scope

Changes span both the web app (`milo-bot-web`) and the agent (`milo-bot-agent`).

## Design

### 1. Database Changes (Web App)

**Add `role` field to User model:**

```prisma
role  String @default("user") @db.VarChar(20)  // "user" | "admin"
```

**New `CuratedModel` table:**

```prisma
model CuratedModel {
  id          String   @id @default(cuid())
  provider    String   @db.VarChar(100)
  modelId     String   @map("model_id") @db.VarChar(200)
  displayName String   @map("display_name") @db.VarChar(200)
  isActive    Boolean  @default(true) @map("is_active")
  sortOrder   Int      @default(0) @map("sort_order")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([provider, modelId])
  @@index([isActive])
  @@map("curated_models")
}
```

### 2. Admin API Endpoints (Web App)

All require session auth + `role === "admin"`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/admin/models` | List all curated models |
| POST   | `/api/admin/models` | Add a curated model |
| PATCH  | `/api/admin/models/[id]` | Update (toggle active, rename, reorder) |
| DELETE | `/api/admin/models/[id]` | Remove a curated model |

### 3. Agent-Facing Endpoint (Web App)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/agent/curated-models` | Fetch active curated models (API key auth) |

Returns `{ models: [{ provider, modelId, displayName }] }` — only active models, ordered by `sortOrder`.

### 4. Admin UI (Web App)

- Route: `app/(dashboard)/admin/models/page.tsx`
- Simple table grouped by provider
- Each row: displayName, modelId, provider, active toggle
- "Add Model" form with provider dropdown, modelId, displayName
- Delete button per row
- Non-admins redirected away

### 5. Agent: Curated Model Cache

New module `app/models/curated-models.ts`:

- Fetches from `GET /api/agent/curated-models`
- In-memory cache with 1-hour TTL
- Force-refreshed on `/models` command
- Exposes `getCuratedModelIds(): Map<provider, Set<modelId>>`

### 6. Agent: Modified `getAvailableModels()`

- Cloud providers (anthropic, openai, google, xai, groq): filter pi-ai's `getModels()` against the curated allow-list
- Providers without configured API keys still excluded
- Falls back to unfiltered list if server unreachable

### 7. Agent: Local Model Detection

- Probe Ollama at `localhost:11434/api/tags` (2s timeout)
- Probe LM Studio at `localhost:1234/v1/models` (2s timeout)
- Ports configurable via `config.json` (`localModels.ollama.port`, `localModels.lmStudio.port`)
- Can be disabled in config (`localModels.ollama.enabled: false`)
- Results merged into `/models` output under "Local Models" section

### 8. Output Format

```
Available Models:
Default model: claude-sonnet-4-6

Cloud Models:
  anthropic:
    - Claude Opus 4.6 (claude-opus-4-6)
    - Claude Sonnet 4.6 (claude-sonnet-4-6)
    - Claude Haiku 4.5 (claude-haiku-4-5)
  openai:
    - o3 Pro (o3-pro)
    - o4 Mini (o4-mini)
    - GPT-4.1 (gpt-4.1)
    - GPT-4.1 Mini (gpt-4.1-mini)
    - GPT-4.1 Nano (gpt-4.1-nano)
  google:
    - Gemini 2.5 Pro (gemini-2.5-pro)
    - Gemini 2.5 Flash (gemini-2.5-flash)
  xai:
    - Grok 4 (grok-4)
    - Grok 4 Fast (grok-4-fast)
    - Grok 3 (grok-3)
    - Grok 3 Mini (grok-3-mini)
  groq:
    - Llama 3.3 70B Versatile (llama-3.3-70b-versatile)
    - ...

Local Models:
  ollama:
    - llama3.2:latest
    - codellama:13b
  lm-studio:
    - deepseek-coder-v2
```

### 9. Data Flow

```
Admin UI --> POST /api/admin/models --> CuratedModel table
                                             |
Agent --> GET /api/agent/curated-models --> cache (1hr TTL)
                                             |
/models command --> filter pi-ai models against cache
                --> probe Ollama/LM Studio
                --> merge and display
```

### 10. Initial Seed Data

The curated models table should be seeded with:

**Anthropic:** claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
**OpenAI:** o3-pro, o4-mini, gpt-4.1, gpt-4.1-mini, gpt-4.1-nano
**Google:** gemini-2.5-pro, gemini-2.5-flash
**xAI:** grok-4, grok-4-fast, grok-3, grok-3-mini
**Groq:** deepseek-r1-distill-llama-70b, llama-3.3-70b-versatile, llama-3.1-8b-instant, gemma2-9b-it
