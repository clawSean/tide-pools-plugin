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
| `openrouter-api` | OpenRouter | OpenRouter `/credits` + `/key` endpoints | Direct (primary) |
| `venice-diem` | Venice | Diem plugin script → HTTP headers | Direct (primary) |
| `openclaw-status` | All | `openclaw status --usage --json` | Fallback (and Anthropic API mode source) |

Direct adapters take priority. If they fail or aren't available, `openclaw-status` fills the gap.

---

### OpenRouter

**Requirements:** An OpenRouter API key accessible by one of these methods (checked in order):

1. Environment variable: `OPENROUTER_API_KEY`, `OPENROUTER_KEY`, or `OPEN_ROUTER_API_KEY`
2. OpenClaw auth-profiles: any `auth-profiles.json` under `~/.openclaw/agents/*/agent/` with `provider: "openrouter"` and `type: "api_key"`

If you've already onboarded OpenRouter as an OpenClaw provider, the key is already in auth-profiles and no extra setup is needed.

**How it works:** Two direct HTTPS calls to OpenRouter — `GET /api/v1/key` (key-level usage/limits) and `GET /api/v1/credits` (account-wide balance; may require a management key).

**If OpenRouter doesn't show up:** No API key was found. Either set the env var or onboard OpenRouter via `openclaw onboard --auth-choice openrouter-api-key`.

Optional env overrides: `OPENROUTER_API_URL`, `OPENROUTER_HTTP_REFERER`, `OPENROUTER_X_TITLE`.

---

### Codex (OpenAI)

**Requirements:** The Codex CLI must have been logged in at least once to create `~/.codex/auth.json`. The CLI does **not** need to be running.

```bash
npm install -g @openai/codex
codex auth
```

**How it works:** Reads the saved OAuth token from `~/.codex/auth.json` and makes a direct HTTPS call to OpenAI's usage endpoint — the same source the web dashboard uses.

**If Codex doesn't show up:** The file `~/.codex/auth.json` doesn't exist. Install the Codex CLI and run `codex auth` once. After that, Tide Pools will pick it up automatically. If the token has expired, you may need to run `codex auth` again.

Note: Codex data will still appear via the `openclaw-status` fallback even without this adapter, but with less detail (no per-window breakdown).

---

### Anthropic (Claude subscription)

**Requirements:** Both `claude` (Claude Code CLI) and `tmux` must be installed and on `$PATH`.

```bash
# Claude Code — see https://docs.anthropic.com/en/docs/claude-code
npm install -g @anthropic-ai/claude-code

# tmux — usually available via your system package manager
apt install tmux     # Debian/Ubuntu
brew install tmux    # macOS
```

**How it works:** Creates a background tmux session running `claude`, sends the `/usage` slash command, and parses the terminal output. This is the only way to get Claude subscription quota data (5-hour window, weekly window, extra usage) — Anthropic does not expose a public API for this.

On first run, the Claude CLI may prompt to "trust this folder." The adapter handles this automatically by accepting the prompt. It also retries from scratch if the session is in a broken state.

**If Anthropic doesn't show up or says "no quota windows":**

- `claude` or `tmux` not installed → adapter is silently skipped, falls back to `openclaw-status`
- Claude CLI not logged in → `/usage` output won't contain subscription windows
- tmux session in a bad state → adapter retries once automatically; if it still fails, check with `tmux capture-pane -t claude_usage_cmd -p` to see what Claude is showing

Optional env overrides:
- `TIDE_POOLS_ANTHROPIC_TMUX_SESSION` (default: `claude_usage_cmd`)
- `TIDE_POOLS_ANTHROPIC_CLAUDE_CMD` (default: `claude`)
- `TIDE_POOLS_ANTHROPIC_TIMEOUT_MS` (default: `20000`)

### Anthropic source modes

- **auto** (default): uses direct Claude `/usage` data when subscription windows are present; falls back to `openclaw status --usage` for API-style usage.
- **api**: disables Claude `/usage` adapter and forces Anthropic data from `openclaw status` fallback.
- **subscription**: requires Claude `/usage` subscription windows (same source as Anthrometer).

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
    │   ├── anthropic-cli-usage.mjs
    │   ├── openrouter-api.mjs
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

🛰️ Providers
• Anthropic Claude [subscription]: 5h: 99% left (in 4h 3m) | week: 22% left (in 3d 16h) — via Claude /usage
  └─ 💳 Extra usage: status enabled · $5.75 / $5.00 spent · $0.00 available · reset in 24d
• OpenRouter: credits: $0.35 / $20.00 (2% used) | balance: $19.65 | key limit: $0.35 / $5.00 (93% left) — via OpenRouter API
• Venice [Diem]: Diem: 0.0000 — via Diem API
• Codex [team]: 5h: 99% left (in 4h 17m) | Week: 88% left (in 5d 6h) — via OpenClaw status

🧮 Usage · last 24h
• Groups: 11.5M tok · $6.10 (4)
• Cron: 724K tok · $0.52 (6)
• DMs: 153K tok · $0.09 (1)

🤖 Top model(s)
• google/gemini-3.1-flash-lite: 10.4M tok · $4.87
• gpt-5.3-codex: 2.0M tok · $1.83

💰 Total
• 12.4M tok · $6.71
```

---

Made with saltwater and stubbornness. 🌊🦞💙
