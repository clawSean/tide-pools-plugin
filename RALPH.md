# RALPH

## Goal
- Restore Tide Pools GPT/OpenAI usage reporting against current OpenClaw ChatGPT OAuth auth profiles.
- Make `/tidepools`/Tide Pools report multiple auth profiles for the same provider kind instead of collapsing them into one row.
- Make Tide Pools reliably read Anthropic subscription `/usage`: 5-hour remaining, weekly remaining, and extra usage balance/status when Claude exposes it.

## Done Means
- [x] Current `provider: "openai"` OAuth profiles are accepted by the OpenAI/Codex usage adapter.
- [x] Live CLI proof shows an OpenAI/Codex usage row from Sean's current ChatGPT OAuth profile without printing secrets.
- [x] Auth-profile discovery preserves distinct same-kind provider profiles when available.
- [x] Adapter/provider merge logic does not collapse distinct provider instances with the same provider kind.
- [x] Focused tests pass.
- [x] CLI proof shows multiple same-kind provider rows without restarting the gateway.
- [x] Anthropic subscription parser exposes 5h/week remaining and extra usage balance/status when present.
- [x] Anthropic parser keeps omitted Extra Usage absent but surfaces exhausted status when Claude exposes it without dollar data.
- [x] Live Anthropic CLI proof reads current 5h/week subscription usage without restarting the gateway.

## Constraints
- Absolutely no gateway restarts.
- Keep scope inside `/root/projects/clawSean/tide-pools-plugin`.
- Do not print secrets; synthetic fixtures/env only for proof.
- User-facing wording should say plugin/plugins; `extensions/` is internal.

## Checks
- `node --test test/*.test.mjs`
- `node ./cli.mjs --format json --no-cache --no-enrich --no-venice`
- Synthetic CLI proof with `OPENCLAW_HOME` pointing at a fixture containing multiple same-provider auth profiles.
- `TIDE_POOLS_ANTHROPIC_TIMEOUT_MS=70000 node ./cli.mjs --format json --theme tide --no-cache --no-enrich --no-venice --anthropic-source subscription`

## Current Slice
- Done: accept current OpenClaw `provider: "openai"` ChatGPT OAuth profiles in Tide Pools' OpenAI/Codex usage adapter and have the direct OAuth row suppress `openclaw-status` OpenAI fallback.
- Done: preserve same-provider auth profiles through adapters and registry merge, then add tests/fixture proof.
- Done: harden Anthropic subscription parser, add tests, extend adapter timeout, prove live 5h/week read, and clarify omitted-vs-exhausted Extra Usage semantics.

## Status
- Iteration: 4/6
- State: done
- Blocker: none
