# Tide Pools v2 — Usage Truth Layer

## Goal
Make Tide Pools’ numbers match the actual provider dashboards. Add optional enrichment from local session logs.

## Current State (v1.6.0)
- `usage-core.mjs` — single source: `openclaw status --usage --json` for provider quota windows
- Venice Diem probe via `~/.openclaw/extensions/diem/diem.py` (parse HTTP headers)
- CLI (`cli.mjs`) + OpenClaw plugin (`index.ts`) with slash commands
- Cache layer (45s TTL, filesystem-based)
- Output: text or JSON

## Architecture for v2

### Layer 1: Provider Source Adapters (ACCURACY — the dashboard numbers)
Each adapter independently fetches usage from the provider's own API/endpoint.

**Adapter interface:**
```js
{
  id: string,              // e.g. "openai-codex-oauth"
  provider: string,        // e.g. "openai-codex"
  probe(): Promise<{       // returns normalized usage
    available: boolean,
    windows: [{ label, used, limit, remaining, usedPercent, resetAt }],
    meta: {},              // provider-specific extras
    error: string|null
  }>,
  isAvailable(): boolean   // quick check (do creds exist?)
}
```

**Adapters to build:**
1. `openclaw-status` — existing `openclaw status --usage --json` (refactored into adapter shape). This is the baseline/fallback for all providers.
2. `openai-codex-oauth` — read `~/.codex/auth.json` for OAuth token, hit `chatgpt.com/backend-api/wham/usage` directly. This is the primary source for OpenAI/Codex (same endpoint CodexBar uses).
3. `venice-diem` — existing Diem probe refactored into adapter shape.

**Adapter resolution:**
- For each provider, run all available adapters
- Prefer direct API adapters over openclaw-status (higher accuracy)
- If direct adapter fails, fall back to openclaw-status data for that provider
- Never block on a failed adapter — timeout + fallback

### Layer 2: Enrichment (VISIBILITY — where usage went)
Mine OpenClaw session JSONL logs for per-session token breakdowns and cost.

**Critical rule: this layer is 100% optional and fault-isolated.**
- Wrapped in try/catch at every level
- If it fails, crashes, or returns garbage: the Layer 1 report renders perfectly fine
- Never imported or called by Layer 1 code paths
- Only appended to output after Layer 1 is complete

**What it provides (when working):**
- Per-session token usage breakdown (which sessions burned what)
- Per-provider cumulative tokens from local logs
- Estimated cost from local pricing data
- Time-series data (usage over the current window)

**Data source:** `/root/.openclaw/agents/mainelobster/sessions/*.jsonl`
Each JSONL has message entries with `message.usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`

### Layer 3: Output
- Text report shows provider numbers + source label ("via OAuth API" / "via OpenClaw status")
- If enrichment available, append breakdown section
- JSON output includes both layers with clear separation
- Confidence/source attribution on every number

## Files to Create/Modify

### New files:
- `adapters/openclaw-status.mjs` — refactored from current parseUsageStatus()
- `adapters/openai-codex-oauth.mjs` — new, reads ~/.codex/auth.json, hits usage API
- `adapters/venice-diem.mjs` — refactored from current getVeniceUsage()
- `adapters/index.mjs` — adapter registry + resolution logic
- `enrichment.mjs` — JSONL mining, completely isolated, every export wrapped in try/catch

### Modified files:
- `usage-core.mjs` — refactor to use adapter registry, add enrichment call (guarded)
- `cli.mjs` — add `--no-enrich` flag, update output
- `index.ts` — no changes needed (it just calls cli.mjs)
- `package.json` — bump to 2.0.0
- `README.md` — update docs

## Codex CLI Dependency
The `openai-codex-oauth` adapter reads `~/.codex/auth.json` for the OAuth access token.
This file exists when the Codex CLI is installed and authenticated.
If the file doesn't exist, the adapter's `isAvailable()` returns false and it's skipped.
The adapter is NOT dependent on the Codex CLI being running — it just reads the stored credentials.

Install: `npm install -g @anthropic-ai/codex` (or however it's currently distributed)
Auth: `codex auth` (one-time OAuth flow)

## Safety Rules
1. Every adapter has its own timeout (default 10s)
2. Every adapter failure is caught and reported, never thrown
3. Enrichment layer failures never affect the main report
4. Cache works the same as v1 (45s TTL, can bypass with --no-cache)
5. No secrets written to disk, stdout, or logs
6. OAuth tokens read from existing credential files, never stored separately

## Output Format (text, example)
```
🌊 Tide Pools

Providers:
• OpenAI Codex [Pro]: 45% left (resets in 2h 15m) — via OAuth API
• Anthropic [Claude]: 80% left (resets in 5h 30m) — via OpenClaw status
• Venice [Diem]: 1,247.3200 Diem | Requests: 980/1000 (98% left) — via Diem API

Session Breakdown (last 24h):
  mainelobster:telegram:direct  — 42,180 tokens ($1.85)
  mainelobster:main             — 18,400 tokens ($0.72)
  cron runs                     — 8,900 tokens ($0.31)
  Total: 69,480 tokens ($2.88)
```

If enrichment fails:
```
🌊 Tide Pools

Providers:
• OpenAI Codex [Pro]: 45% left (resets in 2h 15m) — via OAuth API
• Anthropic [Claude]: 80% left (resets in 5h 30m) — via OpenClaw status
• Venice [Diem]: 1,247.3200 Diem | Requests: 980/1000 (98% left) — via Diem API
```
(No session breakdown section — it just doesn't appear. No error shown to user.)
