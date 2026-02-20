# Three-Level Message Encryption Design

**Date:** 2026-02-19
**Status:** Approved
**Scope:** Agent (`milo-bot/agent`) + Web App (`milo-bot/web`)

## Overview

Three encryption levels users choose per-agent:

| Level | Name | Password on Server | Who Does Message Crypto |
|-------|------|--------------------|------------------------|
| 1 | None | N/A | N/A (plaintext) |
| 2 | Server-Managed | Encrypted with env master key | Browser + Agent (edges only) |
| 3 | E2E Zero-Knowledge | Never stored | Browser + Agent (edges only) |

**Architecture:** Key Hierarchy with Wrapped DEK (envelope encryption pattern).
**Scope:** Encrypts `content`, `formData`, and `fileData` fields.
**Mutability:** Encryption level can change after creation. Old messages stay as-is; new messages use current level.
**Recovery:** No recovery for Level 3. Messages are permanently lost if password is forgotten.

## Crypto Design

### Key Hierarchy

```
password + salt ──PBKDF2──> Master Key (MK)
                                │
random DEK ──AES-GCM(MK)──> wrappedDEK (stored on Agent model + local config)
                                │
message content ──AES-GCM(DEK)──> ciphertext
```

### Primitives

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key Derivation:** PBKDF2, SHA-256, 600,000 iterations
- **Salt:** 32 bytes random, per agent
- **IV:** 12 bytes random, per encryption operation
- **DEK:** 32 bytes random, per agent
- **Implementation:** Web Crypto API (browser), Node.js `crypto` (agent)

### Encrypted Content Format

```
"ENC:1:" + base64( IV[12] || ciphertext[N] || authTag[16] )
```

- `ENC:` prefix marks encrypted content
- `1` = format version
- Unencrypted content has no prefix (backward compatible)

### Password Verifier (Level 3 only)

```
HMAC-SHA256(masterKey, "milo-verify") → base64
```

Stored on server. Browser computes from entered password to validate before attempting decryption.

## Schema Changes

### Agent Model (Prisma — Web)

```prisma
model Agent {
  // ... existing fields ...

  encryptionLevel    Int       @default(1) @map("encryption_level")    // 1=none, 2=server, 3=e2e
  encryptedPassword  String?   @map("encrypted_password")              // Level 2: password encrypted with ENCRYPTION_MASTER_KEY
  passwordSalt       String?   @map("password_salt") @db.VarChar(64)   // Base64 PBKDF2 salt
  passwordVerifier   String?   @map("password_verifier")               // HMAC for password validation
  wrappedDEK         String?   @map("wrapped_dek")                     // DEK encrypted with master key
  wrappedDEKIV       String?   @map("wrapped_dek_iv") @db.VarChar(24)  // IV used to wrap DEK
}
```

No changes to Message model. Encrypted content stored inline in existing fields.

### Agent Config (Local — `config.json`)

```json
{
  "encryption": {
    "level": 1,
    "salt": "base64...",
    "wrappedDEK": "base64...",
    "wrappedDEKIV": "base64..."
  }
}
```

Password stored in OS keychain as `MILO_ENCRYPTION_PASSWORD`.

### Server Environment Variable

```
ENCRYPTION_MASTER_KEY=<64-char hex>  # 256-bit, for Level 2 password encryption only
```

## Encrypted Field Handling

### content (String)

- Plaintext: `"Hello world"`
- Encrypted: `"ENC:1:base64..."`

### formData (Json?)

- Plaintext: `{ "formId": "...", "fields": [...] }`
- Encrypted: `{ "_enc": "ENC:1:base64..." }`
- Entire JSON serialized to string, then encrypted

### fileData (Json?)

- Plaintext: `{ "filename": "doc.pdf", "content": "base64...", "mimeType": "application/pdf", "sizeBytes": 1234 }`
- Encrypted: `{ "filename": "doc.pdf", "mimeType": "application/pdf", "sizeBytes": 1234, "content": "ENC:1:base64..." }`
- Only `content` field encrypted; metadata stays readable for UI display

## Flows

### `milo init` — Setting Up Encryption

```
1. User completes existing init steps (API key, AI keys, model)
2. Prompt: "Choose encryption level" → None / Server-Managed / E2E
3. If Level 2 or 3:
   a. Prompt for password (with confirmation)
   b. Generate 32-byte salt
   c. Derive MK: PBKDF2(password, salt) → masterKey
   d. Generate random 32-byte DEK
   e. Wrap DEK: AES-GCM(DEK, masterKey) → wrappedDEK + wrappedDEKIV
   f. Compute verifier: HMAC-SHA256(masterKey, "milo-verify")
   g. Store in config: level, salt, wrappedDEK, wrappedDEKIV
   h. Store password in OS keychain
   i. PATCH /api/agent/encryption:
      - Level 2: { level, salt, verifier, wrappedDEK, wrappedDEKIV, password }
      - Level 3: { level, salt, verifier, wrappedDEK, wrappedDEKIV }
      (Server encrypts password with ENCRYPTION_MASTER_KEY for Level 2)
```

### Agent Startup — Loading Encryption Key

```
1. Load config → check encryption.level
2. If level > 1:
   a. Load password from OS keychain
   b. Derive MK from password + salt
   c. Unwrap DEK using MK + wrappedDEK + wrappedDEKIV
   d. Cache DEK in memory for the session
3. All message encrypt/decrypt uses cached DEK
```

### User Sends Message (Browser → Agent)

```
1. User types in chat UI
2. Browser has DEK in memory (see "Browser Loading" below)
3. Browser encrypts:
   - content → "ENC:1:base64..."
   - formData (if any) → { "_enc": "ENC:1:..." }
4. POST /api/messages { content: "ENC:1:...", ... }
5. Server stores encrypted blob in DB (never touches content)
6. Server publishes encrypted blob to PubNub cmd channel
7. Agent receives → decrypts with cached DEK → processes plaintext
```

### Agent Sends Message (Agent → Browser)

```
1. Agent generates response (plaintext)
2. Agent encrypts content with cached DEK → "ENC:1:..."
3. Publishes encrypted to PubNub evt channel
4. POSTs encrypted to /api/messages/send → server stores in DB
5. Browser receives PubNub message → decrypts with cached DEK → renders
```

### Browser Loading an Encrypted Agent

**Level 2 (Server-Managed):**
```
1. Browser fetches agent info → sees encryptionLevel=2
2. GET /api/agents/[id]/encryption/password
3. Server decrypts stored password with ENCRYPTION_MASTER_KEY → returns plaintext
4. Browser derives MK from password + salt
5. Browser unwraps DEK using MK + wrappedDEK + wrappedDEKIV
6. DEK cached in memory → transparent encrypt/decrypt
```

**Level 3 (E2E):**
```
1. Browser fetches agent info → sees encryptionLevel=3
2. Modal: "Enter encryption password for [Agent Name]"
3. User enters password
4. Browser derives MK from password + salt
5. Compute verifier → compare with stored passwordVerifier
6. If mismatch → "Incorrect password" error, retry
7. Unwrap DEK using MK + wrappedDEK + wrappedDEKIV
8. DEK cached in memory → transparent encrypt/decrypt
9. Page close/refresh → DEK lost → must re-enter password
```

### Changing Encryption Level

**None → Level 2 or 3:**
```
1. Agent: milo init --reconfigure-encryption (or new command)
2. Enter password, generate salt + DEK, wrap DEK
3. PATCH /api/agent/encryption with new settings
4. Old messages remain plaintext, new messages encrypted
```

**Level 2 → Level 3 (upgrade):**
```
1. Server deletes encryptedPassword
2. Update encryptionLevel to 3
3. Salt, DEK, wrappedDEK unchanged
4. Browser now prompts for password instead of fetching from server
```

**Level 3 → Level 2 (downgrade):**
```
1. User enters password in browser (to prove they know it)
2. Server encrypts password with master key, stores it
3. Update encryptionLevel to 2
```

**Any → None:**
```
1. Update encryptionLevel to 1
2. Clear encryption fields (salt, wrappedDEK, etc.)
3. Old encrypted messages remain encrypted (browser shows "[Encrypted - decryption disabled]")
4. New messages sent as plaintext
```

### Changing Password

```
1. User enters old password + new password (on CLI or web)
2. Derive old MK → unwrap DEK
3. Generate new salt
4. Derive new MK from new password + new salt
5. Re-wrap DEK with new MK
6. Compute new verifier
7. Update: salt, wrappedDEK, wrappedDEKIV, verifier (+ encryptedPassword for Level 2)
8. NO messages re-encrypted — DEK is unchanged
```

## New API Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `PATCH` | `/api/agent/encryption` | x-api-key | Agent sets/updates encryption config |
| `GET` | `/api/agents/[id]/encryption` | session | Get encryption metadata (level, salt, verifier, wrappedDEK, wrappedDEKIV) |
| `GET` | `/api/agents/[id]/encryption/password` | session | Get decrypted password (Level 2 only; 403 for Level 3) |
| `PATCH` | `/api/agents/[id]/encryption` | session | User changes encryption level or password from web UI |

## Web UI Changes

### Agent Settings Page
- Encryption level badge: None / Server-Managed / E2E (lock icons)
- For Level 2: "Change password" button
- For any level: "Change encryption level" option

### Chat Interface
- Lock icon in chat header indicating encryption level
- Level 3: Password prompt modal on agent load
- Failed decryption: message shows "[Unable to decrypt]" with muted styling
- Mixed messages (some encrypted, some not) display correctly

### Agent Creation
- Default: Level 1 (None)
- Encryption configured via `milo init` on the CLI, not during web agent creation
- Web shows encryption status after agent registers

## Agent Code Changes

### New Files
- `app/crypto/encryption.ts` — deriveKey, encrypt, decrypt, wrapDEK, unwrapDEK, computeVerifier
- `app/crypto/message-crypto.ts` — encryptMessage, decryptMessage (handles content/formData/fileData)

### Modified Files
- `app/config/schema.ts` — add `encryption` config section
- `app/commands/init.ts` — add encryption setup step
- `app/orchestrator/orchestrator.ts` — decrypt incoming messages, encrypt outgoing
- `app/orchestrator/worker.ts` — work with plaintext internally (orchestrator handles crypto)
- `app/messaging/pubnub-adapter.ts` — encrypt outgoing events, decrypt incoming
- `app/messaging/webapp-adapter.ts` — encrypt content before REST send
- `app/db/schema.ts` — no changes (encrypted content in existing columns)

## Web Code Changes

### New Files
- `lib/crypto.ts` — Web Crypto API implementations (deriveKey, encrypt, decrypt, wrapDEK, unwrapDEK)
- `lib/server-crypto.ts` — Server-side password encryption with ENCRYPTION_MASTER_KEY
- `app/api/agent/encryption/route.ts` — Agent encryption config endpoint
- `app/api/agents/[id]/encryption/route.ts` — Browser encryption metadata endpoint
- `app/api/agents/[id]/encryption/password/route.ts` — Level 2 password retrieval
- `components/chat/EncryptionPasswordModal.tsx` — Level 3 password prompt
- `hooks/useEncryption.ts` — Encryption key management hook

### Modified Files
- `prisma/schema.prisma` — add encryption fields to Agent
- `hooks/useMessages.ts` — decrypt messages before rendering
- `components/chat/MessageInput.tsx` — encrypt before sending
- `components/chat/ChatWindow.tsx` — pass encryption context
- `components/agents/AgentCard.tsx` — show encryption badge
- `app/api/agents/route.ts` — include encryption fields in response

## Security Considerations

1. **ENCRYPTION_MASTER_KEY** must be stored securely (env var, not in code). Loss = Level 2 passwords unrecoverable.
2. **PBKDF2 at 600k iterations** provides strong brute-force resistance (~200ms per attempt on modern hardware).
3. **AES-256-GCM** provides both confidentiality and integrity (tampered ciphertext fails authentication).
4. **Password verifier** is safe to store — brute-forcing it requires running PBKDF2 for each guess.
5. **Level 3 is true zero-knowledge** — server never sees password or DEK. Only stores wrapped DEK (useless without password).
6. **Transport security** — HTTPS for REST, TLS for PubNub. Encryption adds defense-in-depth.
7. **No password recovery for Level 3** — user warned during setup. This is intentional.
8. **Mixed-encryption messages** — old plaintext and new encrypted messages coexist. Browser handles both.
