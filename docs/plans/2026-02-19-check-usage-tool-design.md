# Check Usage Tool Design

**Date:** 2026-02-19
**Status:** Approved

## Overview

A single `check_usage` agent tool that lets users check their API token usage and costs for Anthropic, OpenAI, or xAI. The tool detects which providers have admin keys configured, presents a form for provider and time period selection, calls the provider's usage/cost API, and returns a formatted report.

## Supported Providers

| Provider | Usage API | Cost API | Auth Key Type |
|----------|-----------|----------|---------------|
| Anthropic | `GET /v1/organizations/usage_report/messages` | `GET /v1/organizations/cost_report` | Admin API key (`sk-ant-admin...`) |
| OpenAI | `GET /v1/organization/usage/completions` | `GET /v1/organization/costs` | Admin Key |
| xAI | `POST management-api.x.ai/v1/billing/teams/{id}/usage` | Invoice preview endpoint | Management Key |

**Not supported:** Groq (no usage API exists), Google/Gemini (requires Google Cloud credentials, not a simple API key).

## Keychain Storage

Admin/management keys stored via `saveToolKey` / `loadToolKey` with the `usage` tool namespace:

| Keychain Account | Description |
|---|---|
| `milo-bot-tool:usage:anthropic-admin-key` | Anthropic Admin API key |
| `milo-bot-tool:usage:openai-admin-key` | OpenAI Admin Key |
| `milo-bot-tool:usage:xai-management-key` | xAI Management Key |

## Tool Definition

- **Name:** `check_usage`
- **Label:** "Check Usage"
- **Description:** "Check API token usage and costs for a provider (Anthropic, OpenAI, or xAI). Requires admin/management keys stored in the OS keychain."
- **Tool sets:** `full`, `minimal`
- **File:** `app/agent-tools/usage-tool.ts`

## User Flow

```
User: "check my token usage"
  -> AI calls check_usage tool (no params required)
  -> Tool checks keychain for 3 admin keys
  -> If 0 found: return error with setup instructions
  -> If 1+ found: send form via ctx.requestForm()
     Form fields:
       - provider (radio): only shows providers with keys configured
       - period (select): "Today", "Last 7 days", "Last 30 days", "Current month"
  -> User submits form
  -> Tool calls selected provider's usage + cost APIs
  -> Tool formats response into readable report
  -> Returns report as tool result
```

## API Details

### Anthropic

**Usage:** `GET https://api.anthropic.com/v1/organizations/usage_report/messages`
- Headers: `x-api-key: {admin_key}`, `anthropic-version: 2023-06-01`
- Params: `starting_at` (ISO), `ending_at` (ISO), `bucket_width=1d`, `group_by[]=model`
- Returns: buckets with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` per model

**Cost:** `GET https://api.anthropic.com/v1/organizations/cost_report`
- Same auth headers
- Params: `starting_at` (ISO), `ending_at` (ISO), `bucket_width=1d`, `group_by[]=description`
- Returns: cost in USD cents per bucket

### OpenAI

**Usage:** `GET https://api.openai.com/v1/organization/usage/completions`
- Headers: `Authorization: Bearer {admin_key}`
- Params: `start_time` (unix seconds), `end_time` (unix seconds), `bucket_width=1d`, `group_by[]=model`
- Returns: buckets with token counts and request counts, paginated via `next_page`

**Cost:** `GET https://api.openai.com/v1/organization/costs`
- Same auth headers
- Params: `start_time` (unix seconds), `bucket_width=1d`
- Returns: cost buckets in USD

### xAI

**Usage/Billing:** `POST https://management-api.x.ai/v1/billing/teams/{team_id}/usage`
- Headers: `Authorization: Bearer {management_key}`
- Need to first list teams or use a stored team_id
- Returns usage and cost data

## Report Format

```
Anthropic Usage Report (Feb 1 - Feb 19, 2026)

Model                  | Input Tokens  | Output Tokens | Cost (USD)
-----------------------|--------------|--------------|----------
claude-opus-4-6        | 1,234,567    | 456,789      | $17.54
claude-sonnet-4-6      | 5,678,901    | 2,345,678    | $52.21

Total: 6,913,468 input / 2,802,467 output tokens | $69.75
```

## Error Handling

- **No admin keys configured:** Return clear instructions on how to set up admin keys for each provider, including where to find them in each provider's console.
- **API auth failure:** Return message indicating the key may be invalid or expired, with link to provider console.
- **API rate limit:** Return message to try again later.
- **Network error:** Return generic error with suggestion to check connectivity.

## Registration

Add `check_usage` to the `full` and `minimal` tool sets in `agent-tools/index.ts`. The tool requires `ToolContext` for `requestForm` access but no other special context.
