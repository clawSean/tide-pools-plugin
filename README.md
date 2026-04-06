# Tide Pools v2 🌊🦞

Provider usage at a glance — with **dashboard-accurate numbers** and session breakdowns.

---

## What changed in v2

v1 had one source per provider: `openclaw status --usage`. v2 introduces **source adapters** that hit provider APIs directly for more accurate data, plus an **enrichment layer** that mines session logs to show where your usage went.

### Architecture

```
Layer 1 (Accuracy)     → Adapter registry: direct provider APIs with fallback
Layer 2 (Enrichment)   → Session JSONL mining: per-session token breakdown
```

Layer 2 is 100% optional. If it fails, the report renders perfectly without it.

---

## Commands

| Command | Description |
|---------|-------------|
| `/tidepools` | Tide-themed report (providers + session breakdown) |
| `/quota_all` | Plain report (supports flags below) |

### Flags on `/quota_all`

| Flag | Effect |
|------|--------|
| `--json` | JSON output |
| `--no-venice` | Skip Venice/Diem probe |
| `--no-enrich` | Skip session JSONL enrichment |
| `--no-cache` | Bypass cache |
| `--cache-ttl-ms N` | Override cache TTL (default: 45000) |
| `--lookback-hours N` | Enrichment lookback period (default: 24) |
| `--anthropic-source auto|api|subscription` | Anthropic source mode: auto (subscription via Claude `/usage`, API via fallback), api (force OpenClaw usage fallback), or subscription (force Claude `/usage`) |

---

## Source Adapters

| Adapter | Provider | Source | Priority |
|---------|----------|--------|----------|
| `openai-codex-oauth` | OpenAI/Codex | `~/.codex/auth.json` → OAuth usage API | Direct (primary) |
| `anthropic-cli-usage` | Anthropic (subscription) | Claude CLI `/usage` via tmux session | Direct (primary for subscription mode) |
| `venice-diem` | Venice | Diem plugin script → HTTP headers | Direct (primary) |
| `openclaw-status` | All | `openclaw status --usage --json` | Fallback (and Anthropic API mode source) |

Direct adapters take priority. If they fail or aren't available, `openclaw-status` fills the gap.

### Anthropic source behavior

- **auto** (default): uses direct Claude `/usage` data when subscription windows are present; falls back to `openclaw status --usage` for API-style usage.
- **api**: disables Claude `/usage` adapter and forces Anthropic data from `openclaw status` fallback.
- **subscription**: requires Claude `/usage` subscription windows (same source as Anthrometer).

Optional env overrides for the Anthropic adapter:
- `TIDE_POOLS_ANTHROPIC_TMUX_SESSION` (default: `claude_usage_cmd`)
- `TIDE_POOLS_ANTHROPIC_CLAUDE_CMD` (default: `claude`)
- `TIDE_POOLS_ANTHROPIC_TIMEOUT_MS` (default: `20000`)

### Adding the Codex OAuth adapter

Install the Codex CLI and authenticate:

```bash
npm install -g @openai/codex
codex auth
```

This creates `~/.codex/auth.json`. Tide Pools reads the OAuth token and hits OpenAI's usage endpoint directly — the same source the web dashboard uses. If the file doesn't exist, the adapter is silently skipped.

---

## Enrichment

When enabled (default), Tide Pools scans recent session JSONL logs to show:

- Per-session token usage (which sessions burned what)
- Cost breakdown (when pricing data available)
- Total tokens and cost for the lookback period

This data comes from OpenClaw's own session logs — it answers "where did my usage go?" while the adapters answer "how much do I have left?"

**Fault-isolated:** If enrichment fails for any reason (missing files, parse errors, permission issues), the main provider report still renders cleanly. The session breakdown section simply doesn't appear.

---

## Installation

Put the plugin in your OpenClaw extensions:

```
~/.openclaw/extensions/
└── tide-pools/
    ├── openclaw.plugin.json
    ├── index.ts
    ├── usage-core.mjs
    ├── enrichment.mjs
    ├── cli.mjs
    ├── adapters/
    │   ├── index.mjs
    │   ├── openclaw-status.mjs
    │   ├── openai-codex-oauth.mjs
    │   └── venice-diem.mjs
    └── README.md
```

Ensure your `openclaw.json` includes:

- `plugins.allow` contains `"tide-pools"`
- `plugins.entries["tide-pools"].enabled = true`

Restart gateway. ✅

---

## Example Output

```
🌊 Tide Pools

• OpenAI Codex [plus]: 5h: 93% left (in 2h 15m) | Day: 48% left (in 4d 17h) — via OpenClaw status
• Venice [Diem]: Diem: 1,247.3200 | Requests: 980/1000 (98% left) — via Diem API

Session Breakdown (last 24h):
  314d15c0…74e4 — 7,187,790 tokens ($2.56)
  bc261223…e7fd — 6,669,858 tokens ($8.99)
  90cb3b3e…1185 — 2,861,466 tokens ($0.71)
  ... and 20 more sessions
  Total: 21,691,262 tokens ($16.37)
```

---

Made with saltwater and stubbornness. 🌊🦞💙
