# Version Tracking & Update Checking

## Overview

The agent tracks its current version and periodically checks GitHub/npm for newer versions. When a newer version is detected, the user is notified via PubNub and the web app is informed via API.

## Current Version Detection

On startup, resolve current version based on install method:

- **Git install:** `git rev-parse --short HEAD` in package root → e.g. `e0af600`
- **npm install:** Read `version` from `package.json` → e.g. `0.1.0`

Cached in orchestrator as `currentVersion`.

## Latest Version Check (Hourly)

Separate timer fires every 60 minutes. On each check:

- **Git install:** `GET https://api.github.com/repos/byronbennett/milo-bot-agent/commits/master` (no auth, public repo). Extract SHA.
- **npm install:** `GET https://registry.npmjs.org/milo-bot-agent/latest`. Extract version.

Compare `latestVersion` against `currentVersion`. Different → `needsUpdate = true`.

## Notification

When `needsUpdate` transitions `false → true`:
- One-time PubNub `agent_status` broadcast: "A newer version is available (current: X, latest: Y)"
- Only once per detected version change, not every hour

## API Reporting

After every check and on startup, call `POST /api/agent/update-status`:
```json
{
  "version": "e0af600",
  "latestVersion": "abc1234",
  "needsUpdate": true
}
```

## Status Report Integration

Add version section to `/status` report:
```
**Version:** e0af600 (git)
**Latest:** abc1234 — update available
```

## Files

| File | Change |
|------|--------|
| `app/orchestrator/updater.ts` | Add `getCurrentVersion()`, `getLatestVersion()`, `checkForUpdates()` |
| `__tests__/orchestrator/updater.test.ts` | Tests for new functions |
| `app/orchestrator/orchestrator.ts` | Add update-check timer, status report integration, API call |
| `app/messaging/webapp-adapter.ts` | Add `sendUpdateStatus()` method |
| `app/shared/api-types.ts` | Add `UpdateStatusRequest` interface |

## No Config Changes

Check interval (1 hour) and GitHub repo URL are hardcoded constants.
