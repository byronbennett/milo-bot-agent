# Curated Model Catalog Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the agent's unfiltered pi-ai model dump with a server-curated catalog managed by site admins, plus auto-detection of local models (Ollama, LM Studio).

**Architecture:** The web app gets a new `CuratedModel` table and admin API/UI for managing the allow-list. A new public endpoint serves the active list to agents. The agent caches this list (1hr TTL), filters pi-ai models against it, and merges in locally-detected Ollama/LM Studio models. The User model gains a `role` field for admin gating.

**Tech Stack:** Prisma (PostgreSQL), Next.js 16 API routes, shadcn/ui, Zod validation, pi-ai model registry, native `fetch` for local probing.

**Repos:** Web app at `/Users/byron/dev/milo-bot/web`, Agent at `/Users/byron/dev/milo-bot/agent`.

---

## Part 1: Web App — Database & Admin Role

### Task 1: Add `role` field to User model and `CuratedModel` table

**Files:**
- Modify: `/Users/byron/dev/milo-bot/web/prisma/schema.prisma:17-36` (User model)
- Modify: `/Users/byron/dev/milo-bot/web/prisma/schema.prisma:223` (add new model after AiModel)

**Step 1: Add `role` field to User model**

In `prisma/schema.prisma`, add `role` field to the User model (after line 23, the `updatedAt` field):

```prisma
model User {
  id            String    @id @default(cuid())
  name          String    @default("")
  email         String    @unique
  emailVerified Boolean   @default(false) @map("email_verified")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")
  role          String    @default("user") @map("role") @db.VarChar(20)

  // Relations
  subscription Subscription?
  agents       Agent[]
  appSessions  AppSession[]
  messages     Message[]

  // BetterAuth tables
  accounts Account[]
  sessions Session[]

  @@map("users")
}
```

**Step 2: Add CuratedModel table**

Add after the AiModel model (after line 223), with a section header:

```prisma
// ============================================================================
// CURATED MODELS (site-wide model catalog managed by admins)
// ============================================================================

model CuratedModel {
  id          String   @id @default(cuid())
  provider    String   @db.VarChar(100)
  modelId     String   @map("model_id") @db.VarChar(200)
  displayName String   @map("display_name") @db.VarChar(200)
  isActive    Boolean  @default(true) @map("is_active")
  sortOrder   Int      @default(0) @map("sort_order")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@unique([provider, modelId])
  @@index([isActive])
  @@map("curated_models")
}
```

**Step 3: Create and run migration**

Run (from `/Users/byron/dev/milo-bot/web`):
```bash
pnpm db:migrate --name add-curated-models-and-user-role
```
Expected: Migration created and applied successfully.

**Step 4: Regenerate Prisma client**

Run:
```bash
pnpm db:generate
```
Expected: Prisma Client generated successfully.

**Step 5: Commit**

```bash
git add prisma/
git commit -m "feat(db): add CuratedModel table and role field to User"
```

---

### Task 2: Add shared types for CuratedModel

**Files:**
- Modify: `/Users/byron/dev/milo-bot/web/shared/types.ts` (add CuratedModel interface near AiModel on line ~91)

**Step 1: Add CuratedModel type**

Add after the `AiModel` interface in `shared/types.ts`:

```typescript
export interface CuratedModel {
  id: string;
  provider: string;
  modelId: string;
  displayName: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Step 2: Commit**

```bash
git add shared/types.ts
git commit -m "feat(types): add CuratedModel interface"
```

---

### Task 3: Create admin auth helper

**Files:**
- Create: `/Users/byron/dev/milo-bot/web/lib/admin-auth.ts`

**Step 1: Create the admin auth helper**

This helper checks session auth AND admin role. Used by all admin API routes.

```typescript
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * Verify the current session belongs to an admin user.
 * Returns the user record if admin, or null.
 */
export async function verifyAdmin() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session?.user) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, role: true },
  });

  if (!user || user.role !== 'admin') return null;
  return user;
}

/**
 * Standard 401/403 response for unauthorized admin access.
 */
export function unauthorizedResponse() {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

**Step 2: Commit**

```bash
git add lib/admin-auth.ts
git commit -m "feat(auth): add admin role verification helper"
```

---

### Task 4: Create admin models API — GET and POST

**Files:**
- Create: `/Users/byron/dev/milo-bot/web/app/api/admin/models/route.ts`

**Step 1: Create the route file**

```typescript
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyAdmin, unauthorizedResponse } from '@/lib/admin-auth';

const createModelSchema = z.object({
  provider: z.string().min(1).max(100),
  modelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

/**
 * GET /api/admin/models — List all curated models
 */
export async function GET() {
  const admin = await verifyAdmin();
  if (!admin) return unauthorizedResponse();

  const models = await prisma.curatedModel.findMany({
    orderBy: [{ provider: 'asc' }, { sortOrder: 'asc' }, { displayName: 'asc' }],
  });

  return NextResponse.json({ models });
}

/**
 * POST /api/admin/models — Add a curated model
 */
export async function POST(request: Request) {
  const admin = await verifyAdmin();
  if (!admin) return unauthorizedResponse();

  const body = await request.json();
  const parsed = createModelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { provider, modelId, displayName, isActive, sortOrder } = parsed.data;

  // Check for duplicate
  const existing = await prisma.curatedModel.findUnique({
    where: { provider_modelId: { provider, modelId } },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Model ${modelId} already exists for provider ${provider}` },
      { status: 409 }
    );
  }

  const model = await prisma.curatedModel.create({
    data: { provider, modelId, displayName, isActive, sortOrder },
  });

  return NextResponse.json({ model }, { status: 201 });
}
```

**Step 2: Commit**

```bash
git add app/api/admin/models/route.ts
git commit -m "feat(api): add GET/POST admin models endpoints"
```

---

### Task 5: Create admin models API — PATCH and DELETE

**Files:**
- Create: `/Users/byron/dev/milo-bot/web/app/api/admin/models/[id]/route.ts`

**Step 1: Create the route file**

```typescript
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyAdmin, unauthorizedResponse } from '@/lib/admin-auth';

const updateModelSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * PATCH /api/admin/models/[id] — Update a curated model
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await verifyAdmin();
  if (!admin) return unauthorizedResponse();

  const { id } = await params;
  const body = await request.json();
  const parsed = updateModelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.curatedModel.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'Model not found' }, { status: 404 });
  }

  const model = await prisma.curatedModel.update({
    where: { id },
    data: parsed.data,
  });

  return NextResponse.json({ model });
}

/**
 * DELETE /api/admin/models/[id] — Remove a curated model
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await verifyAdmin();
  if (!admin) return unauthorizedResponse();

  const { id } = await params;

  const existing = await prisma.curatedModel.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'Model not found' }, { status: 404 });
  }

  await prisma.curatedModel.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
```

**Step 2: Commit**

```bash
git add app/api/admin/models/\[id\]/route.ts
git commit -m "feat(api): add PATCH/DELETE admin models endpoints"
```

---

### Task 6: Create agent-facing curated models endpoint

**Files:**
- Create: `/Users/byron/dev/milo-bot/web/app/api/agent/curated-models/route.ts`

This endpoint is called by the agent (API key auth) to fetch the active curated model list.

**Step 1: Create the route file**

```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyApiKey } from '@/lib/api-key';

/**
 * GET /api/agent/curated-models — Fetch active curated models for agent
 */
export async function GET(request: Request) {
  const apiKey = request.headers.get('x-api-key');
  const agent = await verifyApiKey(apiKey);
  if (!agent) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const models = await prisma.curatedModel.findMany({
    where: { isActive: true },
    select: {
      provider: true,
      modelId: true,
      displayName: true,
    },
    orderBy: [{ provider: 'asc' }, { sortOrder: 'asc' }, { displayName: 'asc' }],
  });

  return NextResponse.json({ models });
}
```

**Step 2: Commit**

```bash
git add app/api/agent/curated-models/route.ts
git commit -m "feat(api): add agent-facing curated-models endpoint"
```

---

### Task 7: Seed the curated models table

**Files:**
- Modify: `/Users/byron/dev/milo-bot/web/prisma/seed.ts`

**Step 1: Add curated model seed data**

Add after the existing test user seed (after line 27), before the "Seeding complete" log:

```typescript
  // Seed curated models (latest-gen models per provider)
  const curatedModels = [
    // Anthropic
    { provider: 'anthropic', modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', sortOrder: 0 },
    { provider: 'anthropic', modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', sortOrder: 1 },
    { provider: 'anthropic', modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', sortOrder: 2 },
    // OpenAI
    { provider: 'openai', modelId: 'o3-pro', displayName: 'o3 Pro', sortOrder: 0 },
    { provider: 'openai', modelId: 'o4-mini', displayName: 'o4 Mini', sortOrder: 1 },
    { provider: 'openai', modelId: 'gpt-4.1', displayName: 'GPT-4.1', sortOrder: 2 },
    { provider: 'openai', modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', sortOrder: 3 },
    { provider: 'openai', modelId: 'gpt-4.1-nano', displayName: 'GPT-4.1 Nano', sortOrder: 4 },
    // Google
    { provider: 'google', modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', sortOrder: 0 },
    { provider: 'google', modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', sortOrder: 1 },
    // xAI
    { provider: 'xai', modelId: 'grok-4', displayName: 'Grok 4', sortOrder: 0 },
    { provider: 'xai', modelId: 'grok-4-fast', displayName: 'Grok 4 Fast', sortOrder: 1 },
    { provider: 'xai', modelId: 'grok-3', displayName: 'Grok 3', sortOrder: 2 },
    { provider: 'xai', modelId: 'grok-3-mini', displayName: 'Grok 3 Mini', sortOrder: 3 },
    // Groq
    { provider: 'groq', modelId: 'deepseek-r1-distill-llama-70b', displayName: 'DeepSeek R1 Distill Llama 70B', sortOrder: 0 },
    { provider: 'groq', modelId: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B Versatile', sortOrder: 1 },
    { provider: 'groq', modelId: 'llama-3.1-8b-instant', displayName: 'Llama 3.1 8B Instant', sortOrder: 2 },
    { provider: 'groq', modelId: 'gemma2-9b-it', displayName: 'Gemma 2 9B IT', sortOrder: 3 },
  ];

  for (const model of curatedModels) {
    await prisma.curatedModel.upsert({
      where: {
        provider_modelId: { provider: model.provider, modelId: model.modelId },
      },
      update: {
        displayName: model.displayName,
        sortOrder: model.sortOrder,
      },
      create: {
        ...model,
        isActive: true,
      },
    });
  }

  console.log(`Seeded ${curatedModels.length} curated models`);
```

**Step 2: Run the seed**

```bash
pnpm db:seed
```
Expected: "Seeded 18 curated models"

**Step 3: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat(seed): add curated model seed data for all providers"
```

---

## Part 2: Web App — Admin UI

### Task 8: Install shadcn table and switch components

**Step 1: Install components**

Run (from `/Users/byron/dev/milo-bot/web`):
```bash
npx shadcn@latest add table switch
```
Expected: Components added to `components/ui/table.tsx` and `components/ui/switch.tsx`.

**Step 2: Commit**

```bash
git add components/ui/table.tsx components/ui/switch.tsx
git commit -m "feat(ui): add shadcn table and switch components"
```

---

### Task 9: Create admin models page

**Files:**
- Create: `/Users/byron/dev/milo-bot/web/app/(dashboard)/admin/models/page.tsx`

**Step 1: Create the admin models page**

This is a client component with:
- Fetch all curated models on mount
- Table grouped by provider with displayName, modelId, active toggle, delete button
- "Add Model" dialog form
- Admin role check (redirect if not admin)

```typescript
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Trash2, Plus } from 'lucide-react';
import type { CuratedModel } from '@/shared/types';

const PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'groq'];

export default function AdminModelsPage() {
  const router = useRouter();
  const [models, setModels] = useState<CuratedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newModel, setNewModel] = useState({
    provider: '',
    modelId: '',
    displayName: '',
  });
  const [adding, setAdding] = useState(false);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/models');
      if (res.status === 403) {
        router.push('/dashboard');
        return;
      }
      if (!res.ok) throw new Error('Failed to fetch models');
      const data = await res.json();
      setModels(data.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const toggleActive = async (id: string, isActive: boolean) => {
    try {
      const res = await fetch(`/api/admin/models/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) throw new Error('Failed to update model');
      setModels((prev) =>
        prev.map((m) => (m.id === id ? { ...m, isActive } : m))
      );
    } catch {
      // Revert on failure
      setModels((prev) =>
        prev.map((m) => (m.id === id ? { ...m, isActive: !isActive } : m))
      );
    }
  };

  const deleteModel = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/models/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete model');
      setModels((prev) => prev.filter((m) => m.id !== id));
    } catch {
      setError('Failed to delete model');
    }
  };

  const addModel = async () => {
    setAdding(true);
    try {
      const res = await fetch('/api/admin/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newModel),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to add model');
      }
      setAddDialogOpen(false);
      setNewModel({ provider: '', modelId: '', displayName: '' });
      await fetchModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add model');
    } finally {
      setAdding(false);
    }
  };

  // Group models by provider
  const grouped = models.reduce<Record<string, CuratedModel[]>>((acc, model) => {
    if (!acc[model.provider]) acc[model.provider] = [];
    acc[model.provider].push(model);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <p className="text-muted-foreground">Loading models...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Curated Models</h1>
          <p className="text-sm text-muted-foreground">
            Manage which AI models are available to agents
          </p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Model
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {Object.entries(grouped).map(([provider, providerModels]) => (
        <Card key={provider} className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              {provider}
              <Badge variant="secondary">{providerModels.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Display Name</TableHead>
                  <TableHead>Model ID</TableHead>
                  <TableHead className="w-24 text-center">Active</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {providerModels.map((model) => (
                  <TableRow key={model.id}>
                    <TableCell className="font-medium">
                      {model.displayName}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {model.modelId}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={model.isActive}
                        onCheckedChange={(checked) =>
                          toggleActive(model.id, checked)
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => deleteModel(model.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}

      {models.length === 0 && (
        <p className="text-center text-muted-foreground">
          No curated models yet. Add some to get started.
        </p>
      )}

      {/* Add Model Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Curated Model</DialogTitle>
            <DialogDescription>
              Add a new model to the curated catalog.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={newModel.provider}
                onValueChange={(value) =>
                  setNewModel((prev) => ({ ...prev, provider: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="modelId">Model ID</Label>
              <Input
                id="modelId"
                placeholder="e.g. claude-opus-4-6"
                value={newModel.modelId}
                onChange={(e) =>
                  setNewModel((prev) => ({ ...prev, modelId: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="displayName">Display Name</Label>
              <Input
                id="displayName"
                placeholder="e.g. Claude Opus 4.6"
                value={newModel.displayName}
                onChange={(e) =>
                  setNewModel((prev) => ({
                    ...prev,
                    displayName: e.target.value,
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={addModel}
              disabled={
                adding ||
                !newModel.provider ||
                !newModel.modelId ||
                !newModel.displayName
              }
            >
              {adding ? 'Adding...' : 'Add Model'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add app/\(dashboard\)/admin/models/page.tsx
git commit -m "feat(ui): add admin curated models management page"
```

---

### Task 10: Add admin link to sidebar (admin-only)

**Files:**
- Modify: `/Users/byron/dev/milo-bot/web/components/dashboard/Sidebar.tsx:280-298`

The Sidebar currently has a Dashboard link section. We need to add an Admin link that only shows for admin users. This requires fetching the current user's role.

**Step 1: Add admin state and fetch**

In `Sidebar.tsx`, add a state for admin role and a useEffect to check. Add these imports:

Add `Shield` to the lucide-react import (line 7-18):
```typescript
import {
  Settings,
  ChevronLeft,
  ChevronRight,
  Bot,
  Plus,
  LayoutDashboard,
  MoreVertical,
  Pencil,
  Puzzle,
  Trash2,
  Shield,
} from 'lucide-react';
```

Add state after the delete dialog state (after line 67):
```typescript
  const [isAdmin, setIsAdmin] = useState(false);
```

Add useEffect after the existing hook calls (after line 81):
```typescript
  useEffect(() => {
    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.role === 'admin') setIsAdmin(true);
      })
      .catch(() => {});
  }, []);
```

**Step 2: Add admin sidebar link**

After the Dashboard link `</div>` (after line 298), add the admin section (only renders for admins):

```tsx
        {/* Admin Section (admin-only) */}
        {isAdmin && (
          <div className="mb-6">
            {!collapsed && (
              <span className="mb-2 block px-2 text-xs font-semibold uppercase text-muted-foreground">
                Admin
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href="/admin/models"
                  className={cn(
                    'flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-accent',
                    pathname.startsWith('/admin') && 'bg-accent',
                    collapsed && 'justify-center'
                  )}
                >
                  <Shield className="h-5 w-5" />
                  {!collapsed && <span>Curated Models</span>}
                </Link>
              </TooltipTrigger>
              {collapsed && <TooltipContent side="right">Curated Models</TooltipContent>}
            </Tooltip>
          </div>
        )}
```

**Step 3: Create the `/api/me` endpoint**

Create `/Users/byron/dev/milo-bot/web/app/api/me/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';

export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true, role: true },
  });

  return NextResponse.json(user);
}
```

**Step 4: Commit**

```bash
git add components/dashboard/Sidebar.tsx app/api/me/route.ts
git commit -m "feat(ui): add admin link in sidebar and /api/me endpoint"
```

---

## Part 3: Agent — Curated Model Cache and Local Detection

### Task 11: Add local models config to agent schema

**Files:**
- Modify: `/Users/byron/dev/milo-bot/agent/app/config/schema.ts:98` (add before closing of agentConfigSchema)

**Step 1: Add localModels config schema**

Add before the `agentConfigSchema` definition (before line 83):

```typescript
export const localModelsConfigSchema = z.object({
  ollama: z.object({
    enabled: z.boolean().default(true),
    port: z.number().default(11434),
  }).default({}),
  lmStudio: z.object({
    enabled: z.boolean().default(true),
    port: z.number().default(1234),
  }).default({}),
  timeoutMs: z.number().default(2000),
});
```

Then add to `agentConfigSchema` (alongside the other config entries):

```typescript
  localModels: localModelsConfigSchema.default({}),
```

**Step 2: Commit**

```bash
git add app/config/schema.ts
git commit -m "feat(config): add localModels config schema for Ollama/LM Studio"
```

---

### Task 12: Add `getCuratedModels` to WebAppAdapter

**Files:**
- Modify: `/Users/byron/dev/milo-bot/agent/app/messaging/webapp-adapter.ts:118` (add after syncModels)

**Step 1: Add the method**

Add after the `syncModels` method (after line 118):

```typescript
  /**
   * Fetch the curated model list from the web app.
   */
  async getCuratedModels(): Promise<Array<{ provider: string; modelId: string; displayName: string }>> {
    const response = await this.request<{
      models: Array<{ provider: string; modelId: string; displayName: string }>;
    }>('GET', '/agent/curated-models');
    return response.models;
  }
```

**Step 2: Commit**

```bash
git add app/messaging/webapp-adapter.ts
git commit -m "feat(adapter): add getCuratedModels method to WebAppAdapter"
```

---

### Task 13: Create curated model cache module

**Files:**
- Create: `/Users/byron/dev/milo-bot/agent/app/models/curated-models.ts`

**Step 1: Create the module**

```typescript
import type { WebAppAdapter } from '../messaging/webapp-adapter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('curated-models');

interface CachedData {
  /** provider → Set of allowed model IDs */
  allowList: Map<string, Set<string>>;
  /** Full model records for display name lookup */
  models: Array<{ provider: string; modelId: string; displayName: string }>;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cache: CachedData | null = null;

/**
 * Fetch the curated allow-list from the server, with in-memory caching.
 * Returns an empty map on failure (caller should fall back to unfiltered).
 */
export async function getCuratedAllowList(
  adapter: WebAppAdapter,
  forceRefresh = false,
): Promise<Map<string, Set<string>>> {
  const now = Date.now();
  if (!forceRefresh && cache && now < cache.expiresAt) {
    return cache.allowList;
  }

  try {
    const models = await adapter.getCuratedModels();
    const allowList = new Map<string, Set<string>>();

    for (const m of models) {
      if (!allowList.has(m.provider)) {
        allowList.set(m.provider, new Set());
      }
      allowList.get(m.provider)!.add(m.modelId);
    }

    cache = { allowList, models, expiresAt: now + CACHE_TTL_MS };
    logger.info(`Loaded ${models.length} curated models from server`);
    return allowList;
  } catch (err) {
    logger.warn('Failed to fetch curated models, using cache or unfiltered:', err);
    // Return stale cache if available, otherwise empty (triggers unfiltered fallback)
    return cache?.allowList ?? new Map();
  }
}

/**
 * Invalidate the cache so the next call fetches fresh data.
 */
export function invalidateCuratedCache(): void {
  cache = null;
}
```

**Step 2: Commit**

```bash
git add app/models/curated-models.ts
git commit -m "feat(models): add curated model cache with 1hr TTL"
```

---

### Task 14: Create local model detection module

**Files:**
- Create: `/Users/byron/dev/milo-bot/agent/app/models/local-models.ts`

**Step 1: Create the module**

```typescript
import type { AgentConfig } from '../config/schema.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('local-models');

export interface LocalModel {
  name: string;
  provider: 'ollama' | 'lm-studio';
}

/**
 * Probe Ollama and LM Studio for locally running models.
 * Returns an empty array if neither is available.
 */
export async function detectLocalModels(config: AgentConfig): Promise<LocalModel[]> {
  const results: LocalModel[] = [];
  const timeoutMs = config.localModels.timeoutMs;

  const probes: Promise<void>[] = [];

  if (config.localModels.ollama.enabled) {
    probes.push(
      (async () => {
        try {
          const res = await fetch(
            `http://localhost:${config.localModels.ollama.port}/api/tags`,
            { signal: AbortSignal.timeout(timeoutMs) },
          );
          if (res.ok) {
            const data = (await res.json()) as { models?: Array<{ name: string }> };
            if (data.models) {
              for (const m of data.models) {
                results.push({ name: m.name, provider: 'ollama' });
              }
            }
          }
        } catch {
          logger.verbose('Ollama not available');
        }
      })(),
    );
  }

  if (config.localModels.lmStudio.enabled) {
    probes.push(
      (async () => {
        try {
          const res = await fetch(
            `http://localhost:${config.localModels.lmStudio.port}/v1/models`,
            { signal: AbortSignal.timeout(timeoutMs) },
          );
          if (res.ok) {
            const data = (await res.json()) as { data?: Array<{ id: string }> };
            if (data.data) {
              for (const m of data.data) {
                results.push({ name: m.id, provider: 'lm-studio' });
              }
            }
          }
        } catch {
          logger.verbose('LM Studio not available');
        }
      })(),
    );
  }

  // Probe in parallel
  await Promise.all(probes);

  if (results.length > 0) {
    logger.info(`Detected ${results.length} local model(s)`);
  }

  return results;
}
```

**Step 2: Commit**

```bash
git add app/models/local-models.ts
git commit -m "feat(models): add Ollama and LM Studio local model detection"
```

---

### Task 15: Modify `getAvailableModels()` in orchestrator

**Files:**
- Modify: `/Users/byron/dev/milo-bot/agent/app/orchestrator/orchestrator.ts:899-948` (getAvailableModels)
- Modify: `/Users/byron/dev/milo-bot/agent/app/orchestrator/orchestrator.ts:642-647` (LIST_MODELS handler)
- Modify: `/Users/byron/dev/milo-bot/agent/app/orchestrator/orchestrator.ts:954-965` (syncModelsToServer)
- Modify: `/Users/byron/dev/milo-bot/agent/app/orchestrator/orchestrator.ts:1278-1290` (status report)

This is the core change. `getAvailableModels()` becomes async, filters by curated list, and includes local models.

**Step 1: Add imports**

Add at the top of `orchestrator.ts` (near the other imports):

```typescript
import { getCuratedAllowList, invalidateCuratedCache } from '../models/curated-models.js';
import { detectLocalModels, type LocalModel } from '../models/local-models.js';
```

**Step 2: Make `getAvailableModels()` async and add filtering**

Replace the entire `getAvailableModels()` method (lines 899-948) with:

```typescript
  private async getAvailableModels(forceRefresh = false): Promise<{
    text: string;
    structured: {
      defaultModel?: string;
      providers: Array<{ provider: string; models: Array<{ id: string; name: string }> }>;
      localModels?: Array<{ provider: string; models: string[] }>;
    };
  }> {
    registerBuiltInApiProviders();

    // Fetch curated allow-list (cached, 1hr TTL)
    const allowList = await getCuratedAllowList(this.restAdapter, forceRefresh);
    const hasCuratedList = allowList.size > 0;

    const allProviders = getProviders();
    const lines: string[] = ['Available Models:'];

    const defaultModel = this.config.ai.agent.model || this.config.ai.utility.model;
    if (defaultModel) {
      lines.push(`\nDefault model: ${defaultModel}`);
    }

    const structuredProviders: Array<{ provider: string; models: Array<{ id: string; name: string }> }> = [];

    lines.push('\nCloud Models:');

    for (const provider of allProviders) {
      const envKey = getEnvApiKey(provider);
      if (!envKey) continue;

      try {
        let models = getModels(provider);

        // Filter by curated list if available
        if (hasCuratedList && allowList.has(provider)) {
          const allowed = allowList.get(provider)!;
          models = models.filter((m) => allowed.has(m.id));
        } else if (hasCuratedList) {
          // Provider not in curated list at all — skip it
          continue;
        }

        if (models.length === 0) continue;

        lines.push(`  ${provider}:`);
        const providerModels: Array<{ id: string; name: string }> = [];
        for (const model of models) {
          lines.push(`    - ${model.name} (${model.id})`);
          providerModels.push({ id: model.id, name: model.name });
        }
        structuredProviders.push({ provider, models: providerModels });
      } catch {
        // Skip providers that fail
      }
    }

    if (structuredProviders.length === 0) {
      lines.push('  No API keys configured. Run `milo init` to add provider keys.');
    }

    // Detect local models
    const localModels = await detectLocalModels(this.config);
    const structuredLocal: Array<{ provider: string; models: string[] }> = [];

    if (localModels.length > 0) {
      lines.push('\nLocal Models:');
      const grouped = new Map<string, string[]>();
      for (const lm of localModels) {
        if (!grouped.has(lm.provider)) grouped.set(lm.provider, []);
        grouped.get(lm.provider)!.push(lm.name);
      }
      for (const [provider, models] of grouped) {
        lines.push(`  ${provider}:`);
        for (const name of models) {
          lines.push(`    - ${name}`);
        }
        structuredLocal.push({ provider, models });
      }
    }

    return {
      text: lines.join('\n'),
      structured: {
        defaultModel: defaultModel || undefined,
        providers: structuredProviders,
        ...(structuredLocal.length > 0 ? { localModels: structuredLocal } : {}),
      },
    };
  }
```

**Step 3: Update LIST_MODELS handler to be async**

Replace lines 642-647:

```typescript
    // LIST_MODELS doesn't need a session/worker — handle inline
    if (workItemType === 'LIST_MODELS') {
      invalidateCuratedCache(); // Force fresh fetch on explicit /models
      const { text, structured } = await this.getAvailableModels(true);
      this.publishModelsList(message.sessionId, structured, text);
      enqueueOutbox(this.db, 'send_message', { sessionId: message.sessionId, content: text }, message.sessionId);
      this.syncModelsToServer();
      return;
    }
```

**Step 4: Update `syncModelsToServer()` to be async**

Replace `syncModelsToServer()` (lines 954-965):

```typescript
  private syncModelsToServer(): void {
    this.getAvailableModels().then(({ structured }) => {
      const models = structured.providers.flatMap((p) =>
        p.models.map((m) => ({ provider: p.provider, modelId: m.id, displayName: m.name }))
      );

      this.restAdapter.syncModels(models).then(() => {
        this.logger.verbose(`Synced ${models.length} models to server`);
      }).catch((err) => {
        this.logger.warn('Failed to sync models to server:', err);
      });
    }).catch((err) => {
      this.logger.warn('Failed to get models for sync:', err);
    });
  }
```

**Step 5: Update status report models section to be async**

The `buildStatusReport` method (which calls `getAvailableModels()` at line 1279) needs to become async. Update the call site at lines 1278-1290:

```typescript
    // --- Models ---
    const { structured } = await this.getAvailableModels();
    const modelCount = structured.providers.reduce((sum, p) => sum + p.models.length, 0);
    const localCount = structured.localModels?.reduce((sum, p) => sum + p.models.length, 0) ?? 0;
    lines.push('');
    lines.push(`#### Models — ${modelCount} cloud${localCount > 0 ? `, ${localCount} local` : ''} across ${structured.providers.length} provider${structured.providers.length !== 1 ? 's' : ''}`);
    if (structured.providers.length === 0) {
      lines.push('*No API keys configured.*');
    } else {
      for (const provider of structured.providers) {
        const names = provider.models.map((m) => `\`${m.name}\``).join(' · ');
        lines.push(`**${provider.provider}:** ${names}`);
      }
    }
    if (structured.localModels) {
      for (const local of structured.localModels) {
        const names = local.models.map((m) => `\`${m}\``).join(' · ');
        lines.push(`**${local.provider}:** ${names}`);
      }
    }
```

Also update the `buildStatusReport` method signature to be `async` and the call site at line 652 to use `await`:

```typescript
    if (workItemType === 'STATUS_REQUEST') {
      const statusText = await this.buildStatusReport(message.sessionId);
```

**Step 6: Commit**

```bash
git add app/orchestrator/orchestrator.ts
git commit -m "feat(models): filter by curated list, detect local models, async getAvailableModels"
```

---

### Task 16: Update PubNub types for local models

**Files:**
- Modify: `/Users/byron/dev/milo-bot/agent/app/messaging/pubnub-types.ts:80-86`

**Step 1: Extend the models type**

Update the `models` field definition to include local models:

```typescript
  models?: {
    defaultModel?: string;
    providers: Array<{
      provider: string;
      models: Array<{ id: string; name: string }>;
    }>;
    localModels?: Array<{
      provider: string;
      models: string[];
    }>;
  };
```

**Step 2: Commit**

```bash
git add app/messaging/pubnub-types.ts
git commit -m "feat(types): extend PubNub models type with localModels field"
```

---

### Task 17: Write tests for curated model cache

**Files:**
- Create: `/Users/byron/dev/milo-bot/agent/__tests__/models/curated-models.test.ts`

**Step 1: Create the test file**

```typescript
import { getCuratedAllowList, invalidateCuratedCache } from '../../app/models/curated-models.js';

// Mock WebAppAdapter
function createMockAdapter(models: Array<{ provider: string; modelId: string; displayName: string }>) {
  return {
    getCuratedModels: jest.fn().mockResolvedValue(models),
  } as any;
}

describe('curated-models', () => {
  beforeEach(() => {
    invalidateCuratedCache();
  });

  it('fetches and caches curated models', async () => {
    const adapter = createMockAdapter([
      { provider: 'anthropic', modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
      { provider: 'anthropic', modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      { provider: 'openai', modelId: 'gpt-4.1', displayName: 'GPT-4.1' },
    ]);

    const result = await getCuratedAllowList(adapter);

    expect(result.size).toBe(2);
    expect(result.get('anthropic')?.has('claude-opus-4-6')).toBe(true);
    expect(result.get('anthropic')?.has('claude-sonnet-4-6')).toBe(true);
    expect(result.get('openai')?.has('gpt-4.1')).toBe(true);
    expect(adapter.getCuratedModels).toHaveBeenCalledTimes(1);
  });

  it('returns cached data on subsequent calls', async () => {
    const adapter = createMockAdapter([
      { provider: 'anthropic', modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
    ]);

    await getCuratedAllowList(adapter);
    await getCuratedAllowList(adapter);

    expect(adapter.getCuratedModels).toHaveBeenCalledTimes(1);
  });

  it('force-refreshes when requested', async () => {
    const adapter = createMockAdapter([
      { provider: 'anthropic', modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
    ]);

    await getCuratedAllowList(adapter);
    await getCuratedAllowList(adapter, true);

    expect(adapter.getCuratedModels).toHaveBeenCalledTimes(2);
  });

  it('returns empty map on fetch failure (no prior cache)', async () => {
    const adapter = {
      getCuratedModels: jest.fn().mockRejectedValue(new Error('Network error')),
    } as any;

    const result = await getCuratedAllowList(adapter);
    expect(result.size).toBe(0);
  });

  it('returns stale cache on fetch failure when cache exists', async () => {
    const adapter = createMockAdapter([
      { provider: 'anthropic', modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
    ]);

    // Prime cache
    await getCuratedAllowList(adapter);

    // Make next call fail
    adapter.getCuratedModels.mockRejectedValue(new Error('Network error'));

    // Force refresh but should get stale cache
    const result = await getCuratedAllowList(adapter, true);
    expect(result.size).toBe(1);
    expect(result.get('anthropic')?.has('claude-opus-4-6')).toBe(true);
  });

  it('invalidates cache', async () => {
    const adapter = createMockAdapter([
      { provider: 'anthropic', modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
    ]);

    await getCuratedAllowList(adapter);
    invalidateCuratedCache();
    await getCuratedAllowList(adapter);

    expect(adapter.getCuratedModels).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run tests**

```bash
cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/models/curated-models.test.ts -v
```

Expected: All 6 tests pass.

**Step 3: Commit**

```bash
git add __tests__/models/curated-models.test.ts
git commit -m "test(models): add curated model cache tests"
```

---

### Task 18: Write tests for local model detection

**Files:**
- Create: `/Users/byron/dev/milo-bot/agent/__tests__/models/local-models.test.ts`

**Step 1: Create the test file**

```typescript
import { detectLocalModels } from '../../app/models/local-models.js';
import type { AgentConfig } from '../../app/config/schema.js';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeConfig(overrides: Partial<AgentConfig['localModels']> = {}): AgentConfig {
  return {
    localModels: {
      ollama: { enabled: true, port: 11434 },
      lmStudio: { enabled: true, port: 1234 },
      timeoutMs: 2000,
      ...overrides,
    },
  } as AgentConfig;
}

describe('detectLocalModels', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('detects Ollama models', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('11434')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [{ name: 'llama3.2:latest' }, { name: 'codellama:13b' }] }),
        });
      }
      return Promise.reject(new Error('Connection refused'));
    });

    const result = await detectLocalModels(makeConfig());
    const ollama = result.filter((m) => m.provider === 'ollama');
    expect(ollama).toHaveLength(2);
    expect(ollama[0].name).toBe('llama3.2:latest');
  });

  it('detects LM Studio models', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('1234')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: 'deepseek-coder-v2' }] }),
        });
      }
      return Promise.reject(new Error('Connection refused'));
    });

    const result = await detectLocalModels(makeConfig());
    const lms = result.filter((m) => m.provider === 'lm-studio');
    expect(lms).toHaveLength(1);
    expect(lms[0].name).toBe('deepseek-coder-v2');
  });

  it('returns empty array when neither is available', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await detectLocalModels(makeConfig());
    expect(result).toHaveLength(0);
  });

  it('respects disabled config', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: 'test' }] }),
    });

    const result = await detectLocalModels(
      makeConfig({ ollama: { enabled: false, port: 11434 }, lmStudio: { enabled: false, port: 1234 } })
    );
    expect(result).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses custom ports from config', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    await detectLocalModels(
      makeConfig({ ollama: { enabled: true, port: 9999 }, lmStudio: { enabled: true, port: 8888 } })
    );

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('9999'),
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('8888'),
      expect.any(Object),
    );
  });
});
```

**Step 2: Run tests**

```bash
cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/models/local-models.test.ts -v
```

Expected: All 5 tests pass.

**Step 3: Commit**

```bash
git add __tests__/models/local-models.test.ts
git commit -m "test(models): add local model detection tests"
```

---

## Part 4: Verification

### Task 19: Build and lint both projects

**Step 1: Lint and type-check the agent**

```bash
cd /Users/byron/dev/milo-bot/agent && pnpm lint && pnpm typecheck
```

Expected: No errors.

**Step 2: Run all agent tests**

```bash
cd /Users/byron/dev/milo-bot/agent && pnpm test
```

Expected: All tests pass.

**Step 3: Lint the web app**

```bash
cd /Users/byron/dev/milo-bot/web && pnpm lint
```

Expected: No errors.

**Step 4: Build the web app**

```bash
cd /Users/byron/dev/milo-bot/web && pnpm build
```

Expected: Build succeeds.

**Step 5: Commit any fixups**

If any lint/type issues arose, fix and commit:

```bash
git commit -m "fix: address lint and type issues from curated models feature"
```

---

### Task 20: Manual verification checklist

- [ ] Set a test user's `role` to `'admin'` in the database
- [ ] Visit `/admin/models` — page loads, shows seeded models grouped by provider
- [ ] Toggle a model's active state — switch updates, refreshes correctly
- [ ] Add a new model via the dialog — appears in the table
- [ ] Delete a model — removed from the table
- [ ] Non-admin user visiting `/admin/models` gets redirected to `/dashboard`
- [ ] Agent calls `GET /api/agent/curated-models` — returns only active models
- [ ] Agent `/models` command shows curated cloud models (filtered) and any local models
- [ ] Agent `/status` shows correct model counts
