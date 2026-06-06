# RALPH LOG

## Iteration 1 — 2026-05-05 20:55 PT

### Slice
- [foreman] Implemented same-provider multi-profile support for Tide Pools.
- Registry now keys rows by `instanceId` instead of provider kind while tracking fallback gaps by provider kind.
- OpenRouter adapter now discovers/probes multiple env/auth-profile keys and returns separate provider rows.
- OpenAI Codex OAuth adapter now discovers/probes multiple local/auth-profile OAuth tokens and returns separate provider rows.
- Added focused `node:test` coverage and `npm test` script.
- Patched ACPX review findings: surfaced per-profile probe failures and destroy sockets on request timeout.

### Verification
- Command/check: `npm test`
- Result: pass
- Evidence: 5/5 node:test tests passed.
- Command/check: synthetic CLI proof with temp `OPENCLAW_HOME` + local HTTP OpenRouter API + `node ./cli.mjs --format json --no-cache --no-enrich --no-venice --anthropic-source api`
- Result: pass
- Evidence: CLI returned two `openrouter` provider rows with distinct `instanceId` values: `openrouter:profile:agentA:openrouter_a`, `openrouter:profile:agentB:openrouter_b`.
- Command/check: `git diff --check`
- Result: pass
- Evidence: no whitespace errors.

### Learnings
- The collapse bug was in the adapter registry (`providerMap.set(p.provider, ...)`) plus single-credential adapter discovery.
- CLI proof server must run asynchronously; `spawnSync` blocks the parent Node event loop and causes local test HTTP requests to time out.

### Next
- DONE unless JPop wants commit/PR packaging.

## Iteration 2 — 2026-05-05 21:12 PT

### Slice
- Used ACPX to review `adapters/anthropic-cli-usage.mjs` for Anthropic subscription `/usage` parsing gaps.
- Exported parser helpers for focused white-box tests.
- Hardened parsing for parenthetical 5h headings, 24-hour reset times, and extra-usage money lines using `used` or `spent`.
- Increased the Anthropic adapter registry timeout so `/usage` has enough time to boot Claude/tmux and return instead of timing out at 25s.
- Fixed Claude REPL readiness detection for the current prompt format (`❯ Try ...`).
- Added Anthropic parser tests.

### Verification
- Command/check: `npm test && git diff --check`
- Result: pass
- Evidence: 10/10 node:test tests passed; no diff whitespace errors.
- Command/check: `TIDE_POOLS_ANTHROPIC_TIMEOUT_MS=70000 node ./cli.mjs --format json --theme tide --no-cache --no-enrich --no-venice --anthropic-source subscription`
- Result: pass
- Evidence: Anthropic provider found via `anthropic-cli-usage`; 5h left 45% (55% used, reset 2026-05-06T08:20:00Z); week left 28% (72% used, reset 2026-05-08T13:00:00Z). Claude `/usage` did not display an Extra Usage section in the current live output, so live extra balance is `null`; parser tests cover enabled/exhausted extra balance when Claude exposes it.

### Learnings
- Current Claude Code screen shows the REPL prompt as `❯ Try ...`, not a bare `❯`, so prompt detection must accept text after the prompt marker.
- Anthropic subscription `/usage` may omit Extra Usage entirely for the current account/state; do not invent a balance when Claude does not expose one.

### Next
- DONE unless JPop wants commit/PR packaging or a UI line that explicitly says “Extra usage: not shown by Claude /usage”.

## Iteration 3 — 2026-05-05 22:05 PT

### Slice
- Re-ran Ralph on the remaining Anthropic Extra Usage behavior after live Claude `/usage` showed 5h/week only and no Extra Usage section.
- Used ACPX as a reviewer for the product semantics.
- Reverted the initial idea to show “not shown by Claude /usage” because absence is likely “not enabled/not displayed,” and showing an unknown extra line would create noise.
- Narrow fix: keep omitted Extra Usage absent, but surface `exhausted` when Claude says “out of extra usage” even without dollar/balance data.
- Added parser/provider tests for omitted Extra Usage and exhausted-status-only output.

### Verification
- Command/check: `npm test && git diff --check`
- Result: pass
- Evidence: 12/12 node:test tests passed; no diff whitespace errors.
- Command/check: `TIDE_POOLS_ANTHROPIC_TIMEOUT_MS=70000 node ./cli.mjs --format json --theme tide --no-cache --no-enrich --no-venice --anthropic-source subscription`
- Result: pass
- Evidence: Anthropic provider found via `anthropic-cli-usage`; live windows were 5h left 24% and week left 26%; `extra: null`, matching Claude `/usage` omitting Extra Usage.

### Learnings
- Claude Code `/usage` has Status/Config/Usage/Stats tabs; current account exposes 5h/week in Status but no Extra Usage in the visible tabs.
- Do not invent an Extra Usage balance/status when Claude omits the section.
- Still preserve a user-visible exhausted state if Claude emits “out of extra usage” without a formal Extra Usage section.

### Next
- DONE unless JPop wants commit/PR packaging.

## Iteration 4 — 2026-06-05 23:08 PT

### Slice
- Restored Tide Pools OpenAI/Codex reporting against current OpenClaw ChatGPT OAuth auth profiles.
- Accepted both legacy `provider: "openai-codex"` and current `provider: "openai"` OAuth profile entries.
- Preserved `ChatGPT-Account-Id` handling for multi-account ChatGPT logins.
- Changed the direct adapter provider kind to canonical `openai` so the direct WHAM row suppresses the `openclaw-status` OpenAI fallback row instead of duplicating it.
- Updated README and focused multi-profile tests.

### Verification
- Command/check: `npm test`
- Result: pass
- Evidence: 31/31 node:test tests passed.
- Command/check: `node ./cli.mjs --format text --theme tide --no-cache --no-enrich --no-venice`
- Result: pass
- Evidence: one OpenAI/Codex row rendered via `OAuth API`: `5h: 98% left` and `week: 54% left`; no duplicate OpenAI row via `OpenClaw status`.
- Command/check: `node ./cli.mjs --format json --no-cache --no-enrich --no-venice`
- Result: pass
- Evidence: OpenAI provider row had `source: "openai-codex-oauth"` and `sourceType: "direct"`; adapter results showed `openai-codex-oauth` available with one provider.

### Learnings
- Current OpenClaw stores ChatGPT OAuth under provider `openai`, not only legacy `openai-codex`.
- Tide Pools fallback suppression must use canonical provider kind `openai`; otherwise the direct adapter and `openclaw-status` fallback both render OpenAI quota rows.

### Next
- DONE.
