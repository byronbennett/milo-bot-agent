# Three-Level Message Encryption Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add three-level per-agent encryption (none, server-managed password, E2E zero-knowledge) using AES-256-GCM with a key hierarchy (password → master key → wrapped DEK → message encryption).

**Architecture:** Encryption happens at the edges only — browser and agent. The web server is a dumb store for encrypted blobs. Server-side crypto is limited to encrypting/decrypting the Level 2 password with an env master key. Key hierarchy uses PBKDF2 to derive a master key from the password, which wraps a random DEK. The DEK encrypts message content.

**Tech Stack:** Node.js `crypto` (agent), Web Crypto API (browser), AES-256-GCM, PBKDF2-SHA256 (600k iterations), Prisma (schema migration), Zod (config validation).

**Repos:**
- Agent: `/Users/byron/dev/milo-bot/agent`
- Web: `/Users/byron/dev/milo-bot/web`

**Design doc:** `docs/plans/2026-02-19-encryption-design.md`

---

## Phase 1: Crypto Foundation

### Task 1: Agent Crypto Module — Core Primitives

**Files:**
- Create: `agent/app/crypto/encryption.ts`
- Create: `agent/__tests__/crypto/encryption.test.ts`

**Step 1: Write failing tests**

```typescript
// __tests__/crypto/encryption.test.ts
import {
  generateSalt,
  deriveKey,
  encrypt,
  decrypt,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  computeVerifier,
} from '../../app/crypto/encryption.js';

describe('crypto/encryption', () => {
  const password = 'test-password-123';

  describe('generateSalt', () => {
    it('returns a 32-byte buffer', () => {
      const salt = generateSalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(32);
    });

    it('returns unique values', () => {
      const a = generateSalt();
      const b = generateSalt();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('deriveKey', () => {
    it('derives a 32-byte key from password and salt', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('same password + salt = same key', () => {
      const salt = generateSalt();
      const a = deriveKey(password, salt);
      const b = deriveKey(password, salt);
      expect(a.equals(b)).toBe(true);
    });

    it('different passwords = different keys', () => {
      const salt = generateSalt();
      const a = deriveKey('password-a', salt);
      const b = deriveKey('password-b', salt);
      expect(a.equals(b)).toBe(false);
    });

    it('different salts = different keys', () => {
      const a = deriveKey(password, generateSalt());
      const b = deriveKey(password, generateSalt());
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips plaintext', () => {
      const key = deriveKey(password, generateSalt());
      const plaintext = 'Hello, encrypted world!';
      const encrypted = encrypt(plaintext, key);
      expect(encrypted).toMatch(/^ENC:1:/);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('decrypt passes through non-encrypted content', () => {
      const key = deriveKey(password, generateSalt());
      expect(decrypt('plain text', key)).toBe('plain text');
    });

    it('different IVs produce different ciphertext', () => {
      const key = deriveKey(password, generateSalt());
      const a = encrypt('same text', key);
      const b = encrypt('same text', key);
      expect(a).not.toBe(b);
    });

    it('wrong key fails to decrypt', () => {
      const salt = generateSalt();
      const key1 = deriveKey('password-1', salt);
      const key2 = deriveKey('password-2', salt);
      const encrypted = encrypt('secret', key1);
      expect(() => decrypt(encrypted, key2)).toThrow();
    });

    it('handles empty string', () => {
      const key = deriveKey(password, generateSalt());
      const encrypted = encrypt('', key);
      expect(decrypt(encrypted, key)).toBe('');
    });

    it('handles unicode', () => {
      const key = deriveKey(password, generateSalt());
      const text = 'Hello \u{1F600} world \u4E16\u754C';
      expect(decrypt(encrypt(text, key), key)).toBe(text);
    });

    it('handles large content', () => {
      const key = deriveKey(password, generateSalt());
      const text = 'x'.repeat(100_000);
      expect(decrypt(encrypt(text, key), key)).toBe(text);
    });
  });

  describe('DEK wrap / unwrap', () => {
    it('round-trips DEK', () => {
      const salt = generateSalt();
      const mk = deriveKey(password, salt);
      const dek = generateDEK();
      expect(dek.length).toBe(32);

      const { wrapped, iv } = wrapDEK(dek, mk);
      const unwrapped = unwrapDEK(wrapped, iv, mk);
      expect(unwrapped.equals(dek)).toBe(true);
    });

    it('wrong master key fails to unwrap', () => {
      const mk1 = deriveKey('pass-1', generateSalt());
      const mk2 = deriveKey('pass-2', generateSalt());
      const dek = generateDEK();
      const { wrapped, iv } = wrapDEK(dek, mk1);
      expect(() => unwrapDEK(wrapped, iv, mk2)).toThrow();
    });
  });

  describe('computeVerifier', () => {
    it('returns a base64 string', () => {
      const key = deriveKey(password, generateSalt());
      const v = computeVerifier(key);
      expect(typeof v).toBe('string');
      expect(Buffer.from(v, 'base64').length).toBe(32);
    });

    it('same key = same verifier', () => {
      const salt = generateSalt();
      const key = deriveKey(password, salt);
      expect(computeVerifier(key)).toBe(computeVerifier(key));
    });

    it('different keys = different verifiers', () => {
      const a = computeVerifier(deriveKey('a', generateSalt()));
      const b = computeVerifier(deriveKey('b', generateSalt()));
      expect(a).not.toBe(b);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/crypto/encryption.test.ts`
Expected: FAIL (module not found)

**Step 3: Write implementation**

```typescript
// app/crypto/encryption.ts
import {
  randomBytes,
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from 'crypto';

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENC_PREFIX = 'ENC:1:';

export function generateSalt(): Buffer {
  return randomBytes(32);
}

export function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

export function generateDEK(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, ct, tag]);
  return ENC_PREFIX + blob.toString('base64');
}

export function decrypt(encrypted: string, key: Buffer): string {
  if (!encrypted.startsWith(ENC_PREFIX)) return encrypted;
  const blob = Buffer.from(encrypted.slice(ENC_PREFIX.length), 'base64');
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ct = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8');
}

export function wrapDEK(dek: Buffer, masterKey: Buffer): { wrapped: string; iv: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    wrapped: Buffer.concat([ct, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function unwrapDEK(wrapped: string, iv: string, masterKey: Buffer): Buffer {
  const blob = Buffer.from(wrapped, 'base64');
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ct = blob.subarray(0, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function computeVerifier(masterKey: Buffer): string {
  return createHmac('sha256', masterKey).update('milo-verify').digest('base64');
}

export function isEncrypted(content: string): boolean {
  return content.startsWith(ENC_PREFIX);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/crypto/encryption.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/crypto/encryption.ts __tests__/crypto/encryption.test.ts
git commit -m "feat(crypto): add core encryption primitives (AES-256-GCM, PBKDF2, DEK wrap/unwrap)"
```

---

### Task 2: Agent Crypto Module — Message-Level Encrypt/Decrypt

**Files:**
- Create: `agent/app/crypto/message-crypto.ts`
- Create: `agent/__tests__/crypto/message-crypto.test.ts`

**Step 1: Write failing tests**

```typescript
// __tests__/crypto/message-crypto.test.ts
import { encryptMessageFields, decryptMessageFields } from '../../app/crypto/message-crypto.js';
import { generateSalt, deriveKey, generateDEK } from '../../app/crypto/encryption.js';

describe('message-crypto', () => {
  let dek: Buffer;

  beforeAll(() => {
    dek = generateDEK();
  });

  describe('encryptMessageFields', () => {
    it('encrypts content field', () => {
      const result = encryptMessageFields({ content: 'hello' }, dek);
      expect(result.content).toMatch(/^ENC:1:/);
    });

    it('encrypts formData as JSON', () => {
      const formData = { formId: 'f1', fields: [{ name: 'email' }] };
      const result = encryptMessageFields({ content: 'hello', formData }, dek);
      expect(result.formData).toHaveProperty('_enc');
      expect((result.formData as Record<string, string>)._enc).toMatch(/^ENC:1:/);
    });

    it('encrypts fileData.content but preserves metadata', () => {
      const fileData = {
        filename: 'doc.pdf',
        content: 'base64filedata',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
      };
      const result = encryptMessageFields({ content: 'hello', fileData }, dek);
      const fd = result.fileData as Record<string, unknown>;
      expect(fd.filename).toBe('doc.pdf');
      expect(fd.mimeType).toBe('application/pdf');
      expect(fd.sizeBytes).toBe(1234);
      expect(fd.content).toMatch(/^ENC:1:/);
    });

    it('handles missing optional fields', () => {
      const result = encryptMessageFields({ content: 'hello' }, dek);
      expect(result.formData).toBeUndefined();
      expect(result.fileData).toBeUndefined();
    });
  });

  describe('decryptMessageFields', () => {
    it('round-trips all fields', () => {
      const original = {
        content: 'secret message',
        formData: { formId: 'f1', fields: [] },
        fileData: {
          filename: 'test.txt',
          content: 'filecontent',
          mimeType: 'text/plain',
          sizeBytes: 11,
        },
      };
      const encrypted = encryptMessageFields(original, dek);
      const decrypted = decryptMessageFields(encrypted, dek);
      expect(decrypted.content).toBe('secret message');
      expect(decrypted.formData).toEqual(original.formData);
      expect((decrypted.fileData as Record<string, unknown>).content).toBe('filecontent');
    });

    it('passes through plaintext content', () => {
      const result = decryptMessageFields({ content: 'plain' }, dek);
      expect(result.content).toBe('plain');
    });

    it('passes through null formData/fileData', () => {
      const result = decryptMessageFields({ content: 'plain' }, dek);
      expect(result.formData).toBeUndefined();
      expect(result.fileData).toBeUndefined();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/crypto/message-crypto.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// app/crypto/message-crypto.ts
import { encrypt, decrypt, isEncrypted } from './encryption.js';

export interface MessageFields {
  content: string;
  formData?: Record<string, unknown> | null;
  fileData?: Record<string, unknown> | null;
}

export function encryptMessageFields(fields: MessageFields, dek: Buffer): MessageFields {
  const result: MessageFields = {
    content: encrypt(fields.content, dek),
  };

  if (fields.formData) {
    result.formData = { _enc: encrypt(JSON.stringify(fields.formData), dek) };
  }

  if (fields.fileData) {
    const fd = { ...fields.fileData };
    if (typeof fd.content === 'string') {
      fd.content = encrypt(fd.content, dek);
    }
    result.fileData = fd;
  }

  return result;
}

export function decryptMessageFields(fields: MessageFields, dek: Buffer): MessageFields {
  const result: MessageFields = {
    content: decrypt(fields.content, dek),
  };

  if (fields.formData) {
    const fd = fields.formData as Record<string, unknown>;
    if (fd._enc && typeof fd._enc === 'string' && isEncrypted(fd._enc)) {
      result.formData = JSON.parse(decrypt(fd._enc as string, dek));
    } else {
      result.formData = fields.formData;
    }
  }

  if (fields.fileData) {
    const fd = { ...fields.fileData };
    if (typeof fd.content === 'string' && isEncrypted(fd.content)) {
      fd.content = decrypt(fd.content, dek);
    }
    result.fileData = fd;
  }

  return result;
}
```

**Step 4: Run tests**

Run: `cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/crypto/message-crypto.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/crypto/message-crypto.ts __tests__/crypto/message-crypto.test.ts
git commit -m "feat(crypto): add message-level field encryption/decryption"
```

---

### Task 3: Agent Config Schema — Add Encryption Section

**Files:**
- Modify: `agent/app/config/schema.ts` (add encryption section after `streaming` field, ~line 112)

**Step 1: Update config schema**

Add to the Zod schema in `app/config/schema.ts`, after the `streaming` field:

```typescript
encryption: z.object({
  level: z.number().min(1).max(3).default(1),
  salt: z.string().optional(),
  wrappedDEK: z.string().optional(),
  wrappedDEKIV: z.string().optional(),
}).default({ level: 1 }),
```

**Step 2: Run type check**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/config/schema.ts
git commit -m "feat(config): add encryption section to agent config schema"
```

---

### Task 4: Web App — Prisma Schema Migration

**Files:**
- Modify: `web/prisma/schema.prisma` (add encryption fields to Agent model, after `needsUpdate` field ~line 156)

**Step 1: Add fields to Agent model**

Add these fields to the Agent model in `prisma/schema.prisma`, after the version tracking fields:

```prisma
  // Encryption
  encryptionLevel    Int       @default(1) @map("encryption_level")         // 1=none, 2=server-managed, 3=e2e
  encryptedPassword  String?   @map("encrypted_password")                   // Level 2: password encrypted with ENCRYPTION_MASTER_KEY
  passwordSalt       String?   @map("password_salt") @db.VarChar(64)        // Base64 PBKDF2 salt
  passwordVerifier   String?   @map("password_verifier")                    // HMAC-SHA256 for password validation
  wrappedDEK         String?   @map("wrapped_dek")                          // DEK encrypted with master key
  wrappedDEKIV       String?   @map("wrapped_dek_iv") @db.VarChar(24)       // IV used to wrap DEK
```

**Step 2: Generate and run migration**

Run: `cd /Users/byron/dev/milo-bot/web && pnpm db:migrate --name add_agent_encryption_fields`
Expected: Migration created and applied

**Step 3: Generate Prisma client**

Run: `cd /Users/byron/dev/milo-bot/web && pnpm db:generate`
Expected: Prisma Client generated

**Step 4: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add prisma/
git commit -m "feat(db): add encryption fields to Agent model"
```

---

### Task 5: Web App — Server-Side Crypto (Master Key Password Encryption)

**Files:**
- Create: `web/lib/server-crypto.ts`

This module handles ONLY the server-side encryption of Level 2 passwords using the `ENCRYPTION_MASTER_KEY` env var. It does NOT touch message content.

**Step 1: Write implementation**

```typescript
// lib/server-crypto.ts
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getMasterKey(): Buffer {
  const hex = process.env.ENCRYPTION_MASTER_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_MASTER_KEY env var must be a 64-char hex string (256-bit key)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a Level 2 agent password with the server master key.
 * Returns a base64 string containing IV + ciphertext + auth tag.
 */
export function encryptPassword(password: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypt a Level 2 agent password with the server master key.
 */
export function decryptPassword(encrypted: string): string {
  const key = getMasterKey();
  const blob = Buffer.from(encrypted, 'base64');
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ct = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8');
}
```

**Step 2: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add lib/server-crypto.ts
git commit -m "feat(crypto): add server-side password encryption with master key"
```

---

### Task 6: Web App — Browser-Side Crypto Module

**Files:**
- Create: `web/lib/crypto.ts`

This is the browser-side crypto module using Web Crypto API. It mirrors the agent crypto module's behavior exactly (same PBKDF2 params, same AES-GCM format) so they produce interoperable ciphertext.

**Step 1: Write implementation**

```typescript
// lib/crypto.ts
// Browser-side encryption using Web Crypto API.
// Interoperable with agent/app/crypto/encryption.ts (same format).

const PBKDF2_ITERATIONS = 600_000;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENC_PREFIX = 'ENC:1:';

// --- Key derivation ---

export async function deriveKey(password: string, saltB64: string): Promise<CryptoKey> {
  const salt = base64ToBytes(saltB64);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true, // extractable for wrapDEK/unwrapDEK
    ['encrypt', 'decrypt'],
  );
}

// --- Message encryption ---

export async function encrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  // Web Crypto appends the 16-byte auth tag to the ciphertext automatically.
  // We store as: IV(12) || ciphertext(N) || tag(16) — same as agent format.
  const blob = new Uint8Array(IV_LENGTH + ct.byteLength);
  blob.set(iv, 0);
  blob.set(ct, IV_LENGTH);
  return ENC_PREFIX + bytesToBase64(blob);
}

export async function decrypt(encrypted: string, key: CryptoKey): Promise<string> {
  if (!encrypted.startsWith(ENC_PREFIX)) return encrypted;
  const blob = base64ToBytes(encrypted.slice(ENC_PREFIX.length));
  const iv = blob.slice(0, IV_LENGTH);
  const ctWithTag = blob.slice(IV_LENGTH);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctWithTag);
  return new TextDecoder().decode(plainBuf);
}

export function isEncrypted(content: string): boolean {
  return content.startsWith(ENC_PREFIX);
}

// --- DEK wrap / unwrap ---

export async function unwrapDEK(
  wrappedB64: string,
  ivB64: string,
  masterKey: CryptoKey,
): Promise<CryptoKey> {
  const wrapped = base64ToBytes(wrappedB64);
  const iv = base64ToBytes(ivB64);
  // wrapped = ciphertext(32) || tag(16)
  const ctWithTag = wrapped;
  const dekRaw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, masterKey, ctWithTag);
  return crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// --- Password verification ---

export async function computeVerifier(masterKey: CryptoKey): Promise<string> {
  const rawKey = await crypto.subtle.exportKey('raw', masterKey);
  const hmacKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode('milo-verify'));
  return bytesToBase64(new Uint8Array(sig));
}

// --- Message field helpers ---

export interface MessageFields {
  content: string;
  formData?: Record<string, unknown> | null;
  fileData?: Record<string, unknown> | null;
}

export async function encryptMessageFields(fields: MessageFields, dek: CryptoKey): Promise<MessageFields> {
  const result: MessageFields = {
    content: await encrypt(fields.content, dek),
  };

  if (fields.formData) {
    result.formData = { _enc: await encrypt(JSON.stringify(fields.formData), dek) };
  }

  if (fields.fileData) {
    const fd = { ...fields.fileData };
    if (typeof fd.content === 'string') {
      fd.content = await encrypt(fd.content, dek);
    }
    result.fileData = fd;
  }

  return result;
}

export async function decryptMessageFields(fields: MessageFields, dek: CryptoKey): Promise<MessageFields> {
  const result: MessageFields = {
    content: await decrypt(fields.content, dek),
  };

  if (fields.formData) {
    const fd = fields.formData as Record<string, unknown>;
    if (fd._enc && typeof fd._enc === 'string' && isEncrypted(fd._enc)) {
      result.formData = JSON.parse(await decrypt(fd._enc as string, dek));
    } else {
      result.formData = fields.formData;
    }
  }

  if (fields.fileData) {
    const fd = { ...fields.fileData };
    if (typeof fd.content === 'string' && isEncrypted(fd.content)) {
      fd.content = await decrypt(fd.content, dek);
    }
    result.fileData = fd;
  }

  return result;
}

// --- Base64 helpers ---

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
```

**Step 2: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add lib/crypto.ts
git commit -m "feat(crypto): add browser-side encryption module (Web Crypto API)"
```

---

## Phase 2: API Endpoints

### Task 7: Web App — Agent Encryption Config Endpoint

**Files:**
- Create: `web/app/api/agent/encryption/route.ts`

This endpoint is called by the agent CLI during `milo init` to set encryption config. Authenticated via `x-api-key` header.

**Step 1: Write the route handler**

```typescript
// app/api/agent/encryption/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyApiKey } from '@/lib/api-key';
import { encryptPassword } from '@/lib/server-crypto';

export async function PATCH(request: Request) {
  const apiKey = request.headers.get('x-api-key');
  const agent = await verifyApiKey(apiKey);
  if (!agent) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { level, salt, verifier, wrappedDEK, wrappedDEKIV, password } = body;

  if (!level || ![1, 2, 3].includes(level)) {
    return NextResponse.json({ error: 'Invalid encryption level (1, 2, or 3)' }, { status: 400 });
  }

  const updateData: Record<string, unknown> = {
    encryptionLevel: level,
    passwordSalt: salt || null,
    passwordVerifier: verifier || null,
    wrappedDEK: wrappedDEK || null,
    wrappedDEKIV: wrappedDEKIV || null,
    encryptedPassword: null,
  };

  // Level 2: encrypt and store the password
  if (level === 2 && password) {
    updateData.encryptedPassword = encryptPassword(password);
  }

  // Level 1: clear all encryption fields
  if (level === 1) {
    updateData.passwordSalt = null;
    updateData.passwordVerifier = null;
    updateData.wrappedDEK = null;
    updateData.wrappedDEKIV = null;
    updateData.encryptedPassword = null;
  }

  await prisma.agent.update({
    where: { id: agent.id },
    data: updateData,
  });

  return NextResponse.json({ ok: true, encryptionLevel: level });
}
```

**Step 2: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add app/api/agent/encryption/route.ts
git commit -m "feat(api): add PATCH /api/agent/encryption for agent config"
```

---

### Task 8: Web App — Browser Encryption Metadata Endpoint

**Files:**
- Create: `web/app/api/agents/[id]/encryption/route.ts`

Browser calls this to get the agent's encryption metadata (level, salt, verifier, wrappedDEK, wrappedDEKIV). Authenticated via BetterAuth session.

**Step 1: Read the existing agents/[id] route structure**

Check: `ls /Users/byron/dev/milo-bot/web/app/api/agents/\[id\]/` to see existing routes.

**Step 2: Write the route handler**

```typescript
// app/api/agents/[id]/encryption/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const agent = await prisma.agent.findFirst({
    where: { id, userId: session.user.id },
    select: {
      encryptionLevel: true,
      passwordSalt: true,
      passwordVerifier: true,
      wrappedDEK: true,
      wrappedDEKIV: true,
    },
  });

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  return NextResponse.json(agent);
}
```

**Step 3: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add "app/api/agents/[id]/encryption/route.ts"
git commit -m "feat(api): add GET /api/agents/[id]/encryption for browser metadata"
```

---

### Task 9: Web App — Level 2 Password Retrieval Endpoint

**Files:**
- Create: `web/app/api/agents/[id]/encryption/password/route.ts`

Browser calls this for Level 2 agents to get the decrypted password. Returns 403 for Level 3 (E2E).

**Step 1: Write the route handler**

```typescript
// app/api/agents/[id]/encryption/password/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { decryptPassword } from '@/lib/server-crypto';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const agent = await prisma.agent.findFirst({
    where: { id, userId: session.user.id },
    select: {
      encryptionLevel: true,
      encryptedPassword: true,
    },
  });

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  if (agent.encryptionLevel !== 2) {
    return NextResponse.json(
      { error: 'Password retrieval is only available for server-managed encryption (Level 2)' },
      { status: 403 },
    );
  }

  if (!agent.encryptedPassword) {
    return NextResponse.json(
      { error: 'No encryption password has been set for this agent' },
      { status: 404 },
    );
  }

  const password = decryptPassword(agent.encryptedPassword);
  return NextResponse.json({ password });
}
```

**Step 2: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add "app/api/agents/[id]/encryption/password/route.ts"
git commit -m "feat(api): add GET /api/agents/[id]/encryption/password for Level 2"
```

---

## Phase 3: Agent Integration

### Task 10: Agent Init Command — Encryption Setup Step

**Files:**
- Modify: `agent/app/commands/init.ts` (~line 707, after AI model selection)

**Step 1: Read the init command file**

Read `app/commands/init.ts` in full, focusing on:
- Where AI model selection ends (~line 707)
- Where the config object is assembled (~line 843-889)
- Where the API registration call happens (if any)

**Step 2: Add encryption setup prompts**

After the AI model selection section, add an encryption setup section. Use `@inquirer/prompts` (already used in the file) for interactive prompts:

```typescript
// --- Encryption Setup ---
logger.info('\n--- Encryption Setup ---');

const encryptionLevel = await select({
  message: 'Choose message encryption level:',
  choices: [
    { name: 'None — messages stored in plaintext (fastest)', value: 1 },
    { name: 'Server-Managed — password stored securely on server', value: 2 },
    { name: 'End-to-End — zero-knowledge, password never leaves your machine', value: 3 },
  ],
});

let encryptionSalt: string | undefined;
let encryptionWrappedDEK: string | undefined;
let encryptionWrappedDEKIV: string | undefined;
let encryptionVerifier: string | undefined;
let encryptionPassword: string | undefined;

if (encryptionLevel > 1) {
  const { password: pwd } = await inquirerPassword({
    message: 'Enter encryption password:',
    mask: '*',
  });
  const { password: confirm } = await inquirerPassword({
    message: 'Confirm encryption password:',
    mask: '*',
  });

  if (pwd !== confirm) {
    logger.error('Passwords do not match. Encryption not configured.');
    process.exit(1);
  }

  if (encryptionLevel === 3) {
    logger.warn(
      '⚠ WARNING: With E2E encryption, there is NO password recovery. ' +
      'If you forget this password, your messages are permanently lost.',
    );
    const proceed = await confirm({
      message: 'Do you understand and want to proceed?',
      default: false,
    });
    if (!proceed) {
      logger.info('Encryption not configured.');
      process.exit(0);
    }
  }

  // Generate crypto materials
  const { generateSalt, deriveKey, generateDEK, wrapDEK, computeVerifier } = await import('../crypto/encryption.js');
  const salt = generateSalt();
  const mk = deriveKey(pwd, salt);
  const dek = generateDEK();
  const { wrapped, iv } = wrapDEK(dek, mk);

  encryptionSalt = salt.toString('base64');
  encryptionWrappedDEK = wrapped;
  encryptionWrappedDEKIV = iv;
  encryptionVerifier = computeVerifier(mk);
  encryptionPassword = encryptionLevel === 2 ? pwd : undefined;

  // Store password in keychain
  const { saveKey } = await import('../utils/keychain.js');
  await saveKey('MILO_ENCRYPTION_PASSWORD', pwd);
  logger.success('Encryption password saved to OS keychain.');
}
```

**Step 3: Add encryption to config object**

In the config object assembly section (~line 843-889), add:

```typescript
encryption: {
  level: encryptionLevel,
  salt: encryptionSalt,
  wrappedDEK: encryptionWrappedDEK,
  wrappedDEKIV: encryptionWrappedDEKIV,
},
```

**Step 4: Add API call to sync encryption config**

After config is saved, call the encryption API:

```typescript
if (encryptionLevel > 1) {
  try {
    const response = await fetch(`${apiUrl}/agent/encryption`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': miloApiKey,
      },
      body: JSON.stringify({
        level: encryptionLevel,
        salt: encryptionSalt,
        verifier: encryptionVerifier,
        wrappedDEK: encryptionWrappedDEK,
        wrappedDEKIV: encryptionWrappedDEKIV,
        password: encryptionPassword, // Only for Level 2
      }),
    });
    if (!response.ok) {
      logger.warn('Failed to sync encryption config to server. You can retry with: milo encryption --sync');
    } else {
      logger.success('Encryption config synced to server.');
    }
  } catch {
    logger.warn('Could not reach server. Encryption config will sync on next start.');
  }
}
```

**Step 5: Run type check**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/commands/init.ts
git commit -m "feat(init): add encryption level and password setup to milo init"
```

---

### Task 11: Agent Orchestrator — Load DEK on Startup

**Files:**
- Modify: `agent/app/orchestrator/orchestrator.ts`

**Step 1: Read orchestrator.ts**

Read the `start()` method to find where initialization happens and where to load the DEK.

**Step 2: Add DEK loading**

In the orchestrator class, add a private field and load the DEK during `start()`:

```typescript
// Add to class fields
private dek: Buffer | null = null;

// Add to start() method, after config is loaded
if (this.config.encryption.level > 1) {
  const { loadKey } = await import('../utils/keychain.js');
  const password = await loadKey('MILO_ENCRYPTION_PASSWORD');
  if (!password) {
    logger.error('Encryption password not found in keychain. Run "milo init" to reconfigure.');
    process.exit(1);
  }
  const { deriveKey, unwrapDEK } = await import('../crypto/encryption.js');
  const salt = Buffer.from(this.config.encryption.salt!, 'base64');
  const mk = deriveKey(password, salt);
  this.dek = unwrapDEK(this.config.encryption.wrappedDEK!, this.config.encryption.wrappedDEKIV!, mk);
  logger.info('Encryption key loaded successfully.');
}
```

**Step 3: Add encrypt/decrypt helper methods**

```typescript
private encryptContent(content: string): string {
  if (!this.dek) return content;
  const { encrypt } = require('../crypto/encryption.js');
  return encrypt(content, this.dek);
}

private decryptContent(content: string): string {
  if (!this.dek) return content;
  const { decrypt } = require('../crypto/encryption.js');
  return decrypt(content, this.dek);
}

private encryptFields(fields: { content: string; formData?: unknown; fileData?: unknown }): typeof fields {
  if (!this.dek) return fields;
  const { encryptMessageFields } = require('../crypto/message-crypto.js');
  return encryptMessageFields(fields, this.dek);
}

private decryptFields(fields: { content: string; formData?: unknown; fileData?: unknown }): typeof fields {
  if (!this.dek) return fields;
  const { decryptMessageFields } = require('../crypto/message-crypto.js');
  return decryptMessageFields(fields, this.dek);
}
```

**Step 4: Run type check**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): load encryption DEK on startup"
```

---

### Task 12: Agent Orchestrator — Decrypt Incoming Messages

**Files:**
- Modify: `agent/app/orchestrator/orchestrator.ts`

**Step 1: Find incoming message handlers**

There are three places where messages arrive:
1. **PubNub listener** (~line 262-293): Real-time messages
2. **REST polling** (~line 1211-1246): Catch-up from heartbeat
3. **Catch-up handler** (~line 568-592): On connect

**Step 2: Add decryption at each ingestion point**

At each point where a message's `content` is read before being routed to a session actor, apply decryption:

```typescript
// After extracting message content from PubNub or REST:
const decrypted = this.decryptFields({
  content: message.content,
  formData: message.formData,
  fileData: message.fileData,
});
// Use decrypted.content instead of message.content when routing to session actor
```

The key principle: **decrypt on ingestion, so workers always see plaintext**. The orchestrator is the encryption boundary.

**Step 3: Run type check**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): decrypt incoming messages at ingestion boundary"
```

---

### Task 13: Agent Messaging Adapters — Encrypt Outgoing Messages

**Files:**
- Modify: `agent/app/messaging/pubnub-adapter.ts` (~line 257, `sendMessage` method)
- Modify: `agent/app/messaging/webapp-adapter.ts` (~line 51, `sendMessage` method)

**Step 1: Read both adapter files**

Read the `sendMessage` method in each to understand the exact signature and how content is passed.

**Step 2: Add encryption parameter to adapters**

The adapters need access to the DEK. Two approaches:
- Pass DEK into adapter constructor
- Pass encrypted content from orchestrator

The cleaner approach is to encrypt in the orchestrator before calling the adapter. The orchestrator already calls `adapter.sendMessage(content, sessionId, formData)`.

**In the orchestrator**, find where `sendMessage` is called and encrypt before calling:

```typescript
// Before calling adapter.sendMessage:
const encrypted = this.encryptFields({ content, formData, fileData });
await this.adapter.sendMessage(encrypted.content, sessionId, encrypted.formData);
```

Also find where PubNub events are published directly (agent_message type) and encrypt:

```typescript
// Before publishing to PubNub evt channel:
const encryptedContent = this.encryptContent(content);
// Use encryptedContent in the PubNub publish payload
```

**Step 3: Run type check**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: PASS

**Step 4: Run tests**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm test`
Expected: All existing tests PASS

**Step 5: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add app/orchestrator/orchestrator.ts app/messaging/pubnub-adapter.ts app/messaging/webapp-adapter.ts
git commit -m "feat(messaging): encrypt outgoing messages before send"
```

---

## Phase 4: Web UI Integration

### Task 14: Web App — useEncryption Hook

**Files:**
- Create: `web/hooks/useEncryption.ts`

This hook manages the encryption key lifecycle for a given agent. It fetches encryption metadata, handles password prompts (Level 3), auto-loads password (Level 2), and provides encrypt/decrypt functions.

**Step 1: Write the hook**

```typescript
// hooks/useEncryption.ts
'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  deriveKey,
  unwrapDEK,
  computeVerifier,
  encryptMessageFields,
  decryptMessageFields,
  type MessageFields,
} from '@/lib/crypto';

interface EncryptionMetadata {
  encryptionLevel: number;
  passwordSalt: string | null;
  passwordVerifier: string | null;
  wrappedDEK: string | null;
  wrappedDEKIV: string | null;
}

interface UseEncryptionReturn {
  /** Whether encryption is active (level > 1) and key is loaded */
  isReady: boolean;
  /** Whether we're waiting for the user to enter a password (Level 3) */
  needsPassword: boolean;
  /** The encryption level (1=none, 2=server, 3=e2e) */
  level: number;
  /** Submit password for Level 3. Returns true if correct. */
  submitPassword: (password: string) => Promise<boolean>;
  /** Encrypt message fields before sending */
  encryptFields: (fields: MessageFields) => Promise<MessageFields>;
  /** Decrypt message fields after receiving */
  decryptFields: (fields: MessageFields) => Promise<MessageFields>;
  /** Error message if something went wrong */
  error: string | null;
}

export function useEncryption(agentId: string | null): UseEncryptionReturn {
  const [metadata, setMetadata] = useState<EncryptionMetadata | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dekRef = useRef<CryptoKey | null>(null);

  // Fetch encryption metadata
  useEffect(() => {
    if (!agentId) return;
    fetch(`/api/agents/${agentId}/encryption`)
      .then((r) => r.json())
      .then((data: EncryptionMetadata) => {
        setMetadata(data);
        if (data.encryptionLevel === 1) {
          setIsReady(true); // No encryption, always ready
        } else if (data.encryptionLevel === 2) {
          loadLevel2Password(agentId, data);
        } else if (data.encryptionLevel === 3) {
          setNeedsPassword(true);
        }
      })
      .catch(() => setError('Failed to load encryption config'));
  }, [agentId]);

  const loadLevel2Password = useCallback(
    async (agentId: string, meta: EncryptionMetadata) => {
      try {
        const r = await fetch(`/api/agents/${agentId}/encryption/password`);
        if (!r.ok) throw new Error('Failed to fetch password');
        const { password } = await r.json();
        await loadDEK(password, meta);
      } catch {
        setError('Failed to load encryption password');
      }
    },
    [],
  );

  const loadDEK = useCallback(async (password: string, meta: EncryptionMetadata) => {
    if (!meta.passwordSalt || !meta.wrappedDEK || !meta.wrappedDEKIV) {
      setError('Incomplete encryption config');
      return false;
    }
    try {
      const mk = await deriveKey(password, meta.passwordSalt);
      // Verify password for Level 3
      if (meta.encryptionLevel === 3 && meta.passwordVerifier) {
        const v = await computeVerifier(mk);
        if (v !== meta.passwordVerifier) {
          return false; // Wrong password
        }
      }
      dekRef.current = await unwrapDEK(meta.wrappedDEK, meta.wrappedDEKIV, mk);
      setIsReady(true);
      setNeedsPassword(false);
      return true;
    } catch {
      return false;
    }
  }, []);

  const submitPassword = useCallback(
    async (password: string): Promise<boolean> => {
      if (!metadata) return false;
      const success = await loadDEK(password, metadata);
      if (!success) setError('Incorrect password');
      return success;
    },
    [metadata, loadDEK],
  );

  const encryptFields = useCallback(
    async (fields: MessageFields): Promise<MessageFields> => {
      if (!dekRef.current) return fields;
      return encryptMessageFields(fields, dekRef.current);
    },
    [],
  );

  const decryptFields = useCallback(
    async (fields: MessageFields): Promise<MessageFields> => {
      if (!dekRef.current) return fields;
      try {
        return await decryptMessageFields(fields, dekRef.current);
      } catch {
        return { ...fields, content: '[Unable to decrypt]' };
      }
    },
    [],
  );

  return {
    isReady,
    needsPassword,
    level: metadata?.encryptionLevel ?? 1,
    submitPassword,
    encryptFields,
    decryptFields,
    error,
  };
}
```

**Step 2: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add hooks/useEncryption.ts
git commit -m "feat(hooks): add useEncryption hook for key lifecycle management"
```

---

### Task 15: Web App — Encryption Password Modal

**Files:**
- Create: `web/components/chat/EncryptionPasswordModal.tsx`

**Step 1: Write the component**

```typescript
// components/chat/EncryptionPasswordModal.tsx
'use client';

import { useState, type FormEvent } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface EncryptionPasswordModalProps {
  agentName: string;
  open: boolean;
  onSubmit: (password: string) => Promise<boolean>;
}

export function EncryptionPasswordModal({ agentName, open, onSubmit }: EncryptionPasswordModalProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const success = await onSubmit(password);
    setLoading(false);
    if (!success) {
      setError('Incorrect password. Please try again.');
      setPassword('');
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Enter Encryption Password</DialogTitle>
          <DialogDescription>
            {agentName} uses end-to-end encryption. Enter the password you set during setup to decrypt messages.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="encryption-password">Password</Label>
            <Input
              id="encryption-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Encryption password"
              autoFocus
              disabled={loading}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <Button type="submit" disabled={!password || loading} className="w-full">
            {loading ? 'Verifying...' : 'Unlock'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add components/chat/EncryptionPasswordModal.tsx
git commit -m "feat(ui): add encryption password modal for E2E agents"
```

---

### Task 16: Web App — Integrate Encryption into Chat Flow

**Files:**
- Modify: `web/hooks/useMessages.ts` — add encryption/decryption calls
- Modify: `web/components/chat/ChatWindow.tsx` — add useEncryption + modal
- Modify: `web/app/(dashboard)/agents/[id]/sessions/[sessionId]/page.tsx` — or wherever ChatWindow is rendered

**Step 1: Read the existing useMessages hook**

Read `hooks/useMessages.ts` in full to understand:
- Where messages are fetched from REST (history load)
- Where PubNub messages are received
- Where messages are sent
- The exact types used

**Step 2: Modify useMessages to accept encrypt/decrypt functions**

Add optional `encryptFields` and `decryptFields` parameters to the hook. When provided, use them:

```typescript
// In useMessages options/params, add:
interface UseMessagesOptions {
  // ... existing options ...
  encryptFields?: (fields: MessageFields) => Promise<MessageFields>;
  decryptFields?: (fields: MessageFields) => Promise<MessageFields>;
}

// When fetching message history (REST), decrypt each message:
const decryptedMessages = await Promise.all(
  messages.map(async (msg) => {
    if (decryptFields && msg.content) {
      const decrypted = await decryptFields({
        content: msg.content,
        formData: msg.formData,
        fileData: msg.fileData,
      });
      return { ...msg, ...decrypted };
    }
    return msg;
  }),
);

// When receiving PubNub message, decrypt:
if (decryptFields && data.content) {
  const decrypted = await decryptFields({ content: data.content });
  data = { ...data, content: decrypted.content };
}

// When sending a message, encrypt:
if (encryptFields) {
  const encrypted = await encryptFields({ content });
  content = encrypted.content;
}
```

**Step 3: Modify ChatWindow to use encryption**

```typescript
// In ChatWindow or the session page:
const encryption = useEncryption(agentId);
const messages = useMessages({
  agentId,
  sessionId,
  encryptFields: encryption.isReady ? encryption.encryptFields : undefined,
  decryptFields: encryption.isReady ? encryption.decryptFields : undefined,
});

// Render password modal for Level 3:
{encryption.needsPassword && (
  <EncryptionPasswordModal
    agentName={agentName}
    open={encryption.needsPassword}
    onSubmit={encryption.submitPassword}
  />
)}

// Show encryption indicator in chat header:
{encryption.level > 1 && (
  <span className="text-xs text-muted-foreground flex items-center gap-1">
    <LockIcon className="h-3 w-3" />
    {encryption.level === 2 ? 'Encrypted' : 'E2E Encrypted'}
  </span>
)}
```

**Step 4: Run type check**

Run: `cd /Users/byron/dev/milo-bot/web && pnpm typecheck`
Expected: PASS (or fix type errors)

**Step 5: Run dev server and test manually**

Run: `cd /Users/byron/dev/milo-bot/web && pnpm dev`
Test: Open browser, navigate to an agent's chat, verify no regressions for Level 1 (unencrypted) agents.

**Step 6: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add hooks/useMessages.ts components/chat/ChatWindow.tsx components/chat/EncryptionPasswordModal.tsx
git commit -m "feat(chat): integrate encryption into message send/receive flow"
```

---

### Task 17: Web App — Encryption Badge on Agent Card

**Files:**
- Modify: `web/components/agents/AgentCard.tsx` (or wherever agents are listed)

**Step 1: Read the agent card component**

Read the component to find where agent metadata is displayed.

**Step 2: Add encryption level badge**

```typescript
// In the agent card, add a badge showing encryption level:
{agent.encryptionLevel > 1 && (
  <Badge variant={agent.encryptionLevel === 3 ? 'default' : 'secondary'} className="text-xs">
    {agent.encryptionLevel === 2 ? 'Encrypted' : 'E2E'}
  </Badge>
)}
```

**Step 3: Ensure agent list API includes encryptionLevel**

Check `GET /api/agents` returns `encryptionLevel`. If not, add it to the Prisma select clause.

**Step 4: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add components/agents/ app/api/agents/route.ts
git commit -m "feat(ui): show encryption level badge on agent cards"
```

---

## Phase 5: Testing & Polish

### Task 18: Agent — End-to-End Encryption Test

**Files:**
- Create: `agent/__tests__/crypto/integration.test.ts`

**Step 1: Write integration test**

Test the full flow: generate keys → encrypt message → decrypt message, simulating the agent-side lifecycle.

```typescript
// __tests__/crypto/integration.test.ts
import {
  generateSalt,
  deriveKey,
  generateDEK,
  wrapDEK,
  unwrapDEK,
  computeVerifier,
} from '../../app/crypto/encryption.js';
import { encryptMessageFields, decryptMessageFields } from '../../app/crypto/message-crypto.js';

describe('encryption integration', () => {
  it('simulates full agent lifecycle: init → encrypt → decrypt', () => {
    // 1. milo init: user enters password
    const password = 'my-secret-password';
    const salt = generateSalt();
    const mk = deriveKey(password, salt);
    const dek = generateDEK();
    const { wrapped, iv } = wrapDEK(dek, mk);
    const verifier = computeVerifier(mk);

    // 2. Agent startup: load DEK
    const mk2 = deriveKey(password, salt);
    const loadedDEK = unwrapDEK(wrapped, iv, mk2);
    expect(loadedDEK.equals(dek)).toBe(true);
    expect(computeVerifier(mk2)).toBe(verifier);

    // 3. Encrypt outgoing message
    const original = {
      content: 'Hello from agent!',
      formData: { formId: 'f1', fields: [{ name: 'email', value: 'test@test.com' }] },
      fileData: { filename: 'readme.md', content: '# Hello', mimeType: 'text/markdown', sizeBytes: 7 },
    };
    const encrypted = encryptMessageFields(original, loadedDEK);
    expect(encrypted.content).toMatch(/^ENC:1:/);

    // 4. Decrypt incoming message (simulating browser or agent receiving)
    const decrypted = decryptMessageFields(encrypted, loadedDEK);
    expect(decrypted.content).toBe('Hello from agent!');
    expect(decrypted.formData).toEqual(original.formData);
    expect((decrypted.fileData as Record<string, unknown>).content).toBe('# Hello');
  });

  it('simulates password change without re-encrypting messages', () => {
    const oldPassword = 'old-pass';
    const newPassword = 'new-pass';
    const salt = generateSalt();

    // Setup with old password
    const oldMK = deriveKey(oldPassword, salt);
    const dek = generateDEK();
    const { wrapped: oldWrapped, iv: oldIV } = wrapDEK(dek, oldMK);

    // Encrypt a message
    const encrypted = encryptMessageFields({ content: 'secret' }, dek);

    // Change password: unwrap with old, re-wrap with new
    const unwrapped = unwrapDEK(oldWrapped, oldIV, oldMK);
    const newSalt = generateSalt();
    const newMK = deriveKey(newPassword, newSalt);
    const { wrapped: newWrapped, iv: newIV } = wrapDEK(unwrapped, newMK);

    // Load with new password
    const loadedDEK = unwrapDEK(newWrapped, newIV, newMK);

    // Old encrypted message still decrypts
    const decrypted = decryptMessageFields(encrypted, loadedDEK);
    expect(decrypted.content).toBe('secret');
  });
});
```

**Step 2: Run tests**

Run: `cd /Users/byron/dev/milo-bot/agent && node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/crypto/integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
cd /Users/byron/dev/milo-bot/agent
git add __tests__/crypto/integration.test.ts
git commit -m "test(crypto): add end-to-end encryption integration tests"
```

---

### Task 19: Web App — Include encryptionLevel in Agent API Responses

**Files:**
- Modify: `web/app/api/agents/route.ts` — add encryptionLevel to the select/return in GET and POST

**Step 1: Read the agents route**

Read `app/api/agents/route.ts` to see the Prisma select clauses.

**Step 2: Add encryptionLevel to responses**

In both the GET (list agents) and POST (create agent) handlers, ensure `encryptionLevel` is included in the Prisma `select` and returned in the response.

**Step 3: Commit**

```bash
cd /Users/byron/dev/milo-bot/web
git add app/api/agents/route.ts
git commit -m "feat(api): include encryptionLevel in agent list/create responses"
```

---

### Task 20: Run Full Test Suites

**Step 1: Agent tests**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm test`
Expected: All tests PASS

**Step 2: Agent type check**

Run: `cd /Users/byron/dev/milo-bot/agent && pnpm typecheck`
Expected: PASS

**Step 3: Web type check**

Run: `cd /Users/byron/dev/milo-bot/web && pnpm typecheck`
Expected: PASS

**Step 4: Web lint**

Run: `cd /Users/byron/dev/milo-bot/web && pnpm lint`
Expected: PASS

---

## Implementation Notes

### What the server NEVER does
- The server never encrypts or decrypts message content. It's a dumb store.
- The server never sees the DEK.
- For Level 3, the server never sees the password.

### Mixed-encryption messages
- Old plaintext messages and new encrypted messages coexist in the same DB.
- `decrypt()` passes through non-`ENC:` content, so plaintext messages render normally.
- Changing encryption level only affects NEW messages.

### PubNub messages
- Agent publishes encrypted content to PubNub evt channel.
- Browser publishes encrypted content to PubNub cmd channel (via REST API which stores and forwards).
- Control messages (DELETE_SESSION, heartbeat, etc.) are NOT encrypted.

### Import note for `@inquirer/prompts`
- The init command already uses `@inquirer/prompts`. Check exact import names (`password` may conflict with variable names — use `import { password as inquirerPassword }` or similar aliasing).

### `keychain.ts` additions
- May need a new `saveKey(name, value)` / `loadKey(name)` generic helper if the existing helpers are all specific (e.g., `saveApiKey`, `loadAnthropicKey`). Check existing keychain.ts for a generic pattern.
