# Dynamic Heartbeat Interval via PubNub

**Date:** 2026-02-21
**Status:** Approved

## Problem

The heartbeat interval is currently fixed at startup (default 3 minutes from config, overridden to 5 seconds when PubNub connects). There's no way for the web client to change the REST heartbeat interval at runtime.

## Design

### Flow

1. Web client sends a PubNub control message: `{ type: 'ui_action', ui_action: 'SET_HEARTBEAT_INTERVAL', intervalMinutes: N }`
2. Orchestrator receives it in `handlePubNubControl()`, validates `intervalMinutes` (must be > 2, <= 60)
3. Calls `this.scheduler.setInterval(N)` to restart the cron job with the new interval
4. Persists the new value to `config.json` so it survives restarts
5. Publishes a confirmation event back via PubNub

### Status Report

The `buildStatusReport()` header table gains a "Heartbeat" column showing the current configured interval (e.g., "3 min").

### Files Changed

| File | Change |
|------|--------|
| `app/orchestrator/orchestrator.ts` | Add `SET_HEARTBEAT_INTERVAL` handler in `handlePubNubControl()`, add heartbeat interval to status header table |
| `app/messaging/pubnub-types.ts` | Add `SET_HEARTBEAT_INTERVAL` to ui_action union |
| `app/config/index.ts` | Add `updateConfigFile()` helper to persist config changes to disk |

### Validation

- `intervalMinutes` must be a number, > 2, <= 60
- Invalid values are logged as warnings and ignored

### Edge Case: PubNub 5-Second Override

The PubNub 5-second heartbeat override for real-time mode is separate. `SET_HEARTBEAT_INTERVAL` changes the configured REST heartbeat interval (used on restart and when PubNub is disconnected). The PubNub override continues to work independently.

### Persistence

New interval is written to `config.json` under `scheduler.heartbeatIntervalMinutes`, becoming the new default for future restarts.
