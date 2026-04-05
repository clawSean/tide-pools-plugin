# Tide Pools Plugin 🌊🦞✨

A cheerful little OpenClaw plugin that gives you **provider usage at a glance** with **zero LLM inference** for command handling.

Think of it as your quota shoreline: one look, and you know what’s still swimming. 🐟

---

## 🧭 What this plugin does

• Adds direct slash commands for quota visibility  
• Works without invoking the main AI for command parsing  
• Supports plain + themed output  
• Optionally augments Venice via your existing Diem plugin

---

## 🗣️ Commands

• `/tide_pools`  
  Tide-themed human-readable status board 🌊

• `/tidepools`  
  Alias for `/tide_pools`

• `/lobster_usage`  
  Legacy alias for `/tide_pools` (kept for compatibility)

• `/quota_all`  
  Plain status board

• `/quota_all --json`  
  Machine-readable JSON snapshot

### Optional flags on `/quota_all`

• `--json` → JSON output  
• `--no-venice` → skip Venice augmentation from diem plugin  
• `--no-cache` → bypass short cache  
• `--cache-ttl-ms <N>` → override cache TTL (default: `45000`)

---

## 📦 Where to put this folder (noob-friendly)

Put the plugin here on your OpenClaw host:

```text
~/.openclaw/extensions/
└── tide-pools/
    ├── openclaw.plugin.json
    ├── index.ts
    ├── usage-core.mjs
    ├── cli.mjs
    └── README.md
```

Then ensure your `openclaw.json` includes:

• `plugins.allow` contains `"tide-pools"`  
• `plugins.entries["tide-pools"].enabled = true`

Then restart gateway. ✅

---

## 🪙 Venice support

If `openclaw status --usage` doesn’t show Venice directly, Tide Pools can enrich output via:

`~/.openclaw/extensions/diem/diem.py`

If that script is missing/unavailable, Tide Pools still works and reports Venice as unavailable.

---

## 🤝 Bottom Feeder integration

Bottom Feeder can consume Tide Pools directly via:

`skills/bottom-feeder/scripts/provider-usage.sh`

It checks Tide Pools first, then legacy lobster path, then falls back to `openclaw status --usage --json`.

---

## 🧩 Files in this plugin

• `openclaw.plugin.json` — plugin manifest  
• `index.ts` — command registration  
• `usage-core.mjs` — usage collection + formatting logic  
• `cli.mjs` — CLI wrapper (text/json)

---

Made with saltwater and stubbornness. 🌊🦞💙
