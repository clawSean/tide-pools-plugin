/**
 * Tide Pools v2 — Usage Core
 *
 * Architecture:
 *   Layer 1 (Accuracy): Adapter registry fetches dashboard-accurate numbers
 *                        from provider APIs with priority + fallback.
 *   Layer 2 (Enrichment): JSONL session mining shows where usage went.
 *                          100% optional — never blocks Layer 1.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAll } from "./adapters/index.mjs";

const DEFAULT_CACHE_TTL_MS = 45_000;

// ─── Cache ──────────────────────────────────��────────────────────────────────

function resolveCachePath(customPath) {
  if (customPath) return customPath;
  if (process.env.TIDE_POOL_CACHE_PATH) return process.env.TIDE_POOL_CACHE_PATH;
  if (process.env.LOBSTER_USAGE_CACHE_PATH) return process.env.LOBSTER_USAGE_CACHE_PATH;
  return path.join(os.tmpdir(), "openclaw-tide-pools-cache.json");
}

function readCache(cachePath, ttlMs, cacheKey = null) {
  if (!ttlMs || ttlMs <= 0) return null;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.cachedAtMs !== "number" || !parsed.snapshot) return null;
    if (Date.now() - parsed.cachedAtMs > ttlMs) return null;
    if (cacheKey) {
      const expected = JSON.stringify(cacheKey);
      const actual = JSON.stringify(parsed.cacheKey || null);
      if (expected !== actual) return null;
    }
    return parsed.snapshot;
  } catch {
    return null;
  }
}

function writeCache(cachePath, snapshot, cacheKey = null) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ cachedAtMs: Date.now(), snapshot, cacheKey }));
  } catch {
    // best-effort cache
  }
}

// ─── Enrichment (fault-isolated import) ──────────────────────────────────────

let _enrichmentModule = null;

async function loadEnrichment() {
  if (_enrichmentModule !== null) return _enrichmentModule;
  try {
    _enrichmentModule = await import("./enrichment.mjs");
  } catch {
    _enrichmentModule = false; // mark as failed so we don't retry
  }
  return _enrichmentModule;
}

async function safeCollectEnrichment(opts) {
  try {
    const mod = await loadEnrichment();
    if (!mod) return { available: false };
    return mod.collectEnrichment(opts);
  } catch {
    return { available: false };
  }
}

async function safeFormatEnrichment(enrichment, opts) {
  try {
    const mod = await loadEnrichment();
    if (!mod) return null;
    return mod.formatEnrichment(enrichment, opts);
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countdown(resetAt) {
  let resetAtMs;
  if (typeof resetAt === "number") {
    resetAtMs = resetAt;
  } else if (typeof resetAt === "string") {
    resetAtMs = new Date(resetAt).getTime();
  } else {
    return "reset unknown";
  }

  if (Number.isNaN(resetAtMs)) return "reset unknown";

  const delta = Math.max(0, resetAtMs - Date.now());
  const totalMins = Math.floor(delta / 60000);
  const d = Math.floor(totalMins / 1440);
  const h = Math.floor((totalMins % 1440) / 60);
  const m = totalMins % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return `in ${parts.join(" ")}`;
}

// ─── Snapshot Collection ─────────────────────────────────────────────────────

/**
 * Collect a full usage snapshot: adapters + optional enrichment.
 *
 * @param {object} opts
 * @param {boolean} opts.includeVenice
 * @param {boolean} opts.includeEnrichment
 * @param {number}  opts.cacheTtlMs
 * @param {string}  opts.cachePath
 * @param {boolean} opts.bypassCache
 * @param {number}  opts.enrichmentLookbackHours
 */
export async function collectUsageSnapshot(opts = {}) {
  const includeVenice = opts.includeVenice !== false;
  const includeEnrichment = opts.includeEnrichment !== false;
  const anthropicSource = String(opts.anthropicSource || "auto").toLowerCase();
  const cacheTtlMs = Number.isFinite(opts.cacheTtlMs)
    ? Number(opts.cacheTtlMs)
    : DEFAULT_CACHE_TTL_MS;
  const cachePath = resolveCachePath(opts.cachePath);
  const bypassCache = opts.bypassCache === true;
  const cacheKey = { includeVenice, includeEnrichment, anthropicSource };

  // Check cache
  if (!bypassCache) {
    const cached = readCache(cachePath, cacheTtlMs, cacheKey);
    if (cached) {
      return {
        ...cached,
        cache: { hit: true, ttlMs: cacheTtlMs, path: cachePath },
      };
    }
  }

  // Layer 1 + Layer 2 in parallel (enrichment is independent of adapters)
  const [resolved, enrichment] = await Promise.all([
    resolveAll({ includeVenice, anthropicSource }),
    includeEnrichment
      ? safeCollectEnrichment({ lookbackHours: opts.enrichmentLookbackHours })
      : null,
  ]);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    version: "2.0.0",
    providers: resolved.providers,
    adapterResults: resolved.adapterResults,
    enrichment,
  };

  // Write cache
  if (!bypassCache && cacheTtlMs > 0) writeCache(cachePath, snapshot, cacheKey);

  return {
    ...snapshot,
    cache: { hit: false, ttlMs: cacheTtlMs, path: cachePath },
  };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function anthropicResetText(w) {
  if (w?.resetIn) return `in ${w.resetIn}`;
  return countdown(w?.resetAt);
}

function formatAnthropicLine(p, sourceTag) {
  const name = p.displayName || "Anthropic";
  const plan = p.plan ? ` [${p.plan}]` : "";
  const windows = Array.isArray(p.windows) ? p.windows : [];

  if (p.error && !windows.length) {
    return `• **${name}${plan}**: unavailable — ${p.error}${sourceTag}`;
  }

  const byLabel = Object.fromEntries(windows.map((w) => [String(w.label || "").toLowerCase(), w]));
  const five = byLabel["5h"];
  const week = byLabel["week"];
  const apiMonth = byLabel["api-month"];
  const extra = byLabel["extra"];

  const chunks = [];
  if (five) {
    const leftTxt = five.leftPercent != null ? `${five.leftPercent}% left` : "left unknown";
    chunks.push(`5h: ${leftTxt} (${anthropicResetText(five)})`);
  }
  if (week) {
    const leftTxt = week.leftPercent != null ? `${week.leftPercent}% left` : "left unknown";
    chunks.push(`week: ${leftTxt} (${anthropicResetText(week)})`);
  }
  if (apiMonth) {
    const leftTxt = apiMonth.leftPercent != null ? `${apiMonth.leftPercent}% left` : "left unknown";
    chunks.push(`api-month: ${leftTxt} (${anthropicResetText(apiMonth)})`);
  }

  const head = chunks.length
    ? `• **${name}${plan}**: ${chunks.join(" | ")}${sourceTag}`
    : `• **${name}${plan}**: no quota windows${sourceTag}`;

  const extraParts = [];
  if (extra) {
    if (extra.status) extraParts.push(`status ${extra.status}`);
    if (extra.spentUsd != null && extra.limitUsd != null) {
      extraParts.push(`$${Number(extra.spentUsd).toFixed(2)} / $${Number(extra.limitUsd).toFixed(2)} spent`);
    }
    if (extra.availableUsd != null) extraParts.push(`$${Number(extra.availableUsd).toFixed(2)} available`);
    if (extra.overUsd != null && Number(extra.overUsd) > 0) extraParts.push(`over by $${Number(extra.overUsd).toFixed(2)}`);
    if (extra.resetAt || extra.resetIn) extraParts.push(`reset ${anthropicResetText(extra)}`);
  }

  if (!extraParts.length) return head;
  return `${head}\n  └─ 💳 **Extra usage**: ${extraParts.join(" · ")}`;
}

function formatProviderLine(p) {
  const name = p.displayName || p.provider || "Unknown provider";
  const plan = p.plan ? ` [${p.plan}]` : "";
  const sourceTag = p.source ? ` — via ${formatSourceName(p.source)}` : "";

  // Venice is special: uses Diem balance + rate limits
  if (p.provider === "venice") {
    return formatVeniceLine(p, sourceTag);
  }

  // Anthropic is special: subscription windows + extra usage details
  if (String(p.provider || "").toLowerCase() === "anthropic") {
    return formatAnthropicLine(p, sourceTag);
  }

  // OpenRouter is special: account credits + key-level usage windows
  if (String(p.provider || "").toLowerCase() === "openrouter") {
    return formatOpenRouterLine(p, sourceTag);
  }

  if (p.error) return `• **${name}${plan}**: unavailable — ${p.error}${sourceTag}`;

  const windows = Array.isArray(p.windows) ? p.windows : [];
  if (!windows.length) return `• **${name}${plan}**: no quota windows${sourceTag}`;

  const chunks = windows.map((w) => {
    const label = w.label || "window";
    const leftTxt =
      w.leftPercent != null ? `${w.leftPercent}% left` : "left unknown";
    return `${label}: ${leftTxt} (${countdown(w.resetAt)})`;
  });

  return `• **${name}${plan}**: ${chunks.join(" | ")}${sourceTag}`;
}

function formatVeniceLine(p, sourceTag) {
  if (p.error && !p.diem && !p.requests && !p.tokens) {
    return `• **Venice [Diem]**: unavailable — ${p.error}${sourceTag}`;
  }

  const chunks = [];
  if (p.diem != null) chunks.push(`Diem: ${Number(p.diem).toFixed(4)}`);

  if (p.requests) {
    chunks.push(
      `Requests: ${p.requests.remaining}/${p.requests.limit} (${p.requests.leftPercent ?? "?"}% left)`
    );
  }

  if (p.tokens) {
    chunks.push(
      `Tokens: ${Number(p.tokens.remaining).toLocaleString()}/${Number(p.tokens.limit).toLocaleString()} (${p.tokens.leftPercent ?? "?"}% left)`
    );
  }

  if (!chunks.length) {
    return `• **Venice [Diem]**: no balance data${sourceTag}`;
  }

  return `• **Venice [Diem]**: ${chunks.join(" | ")}${sourceTag}`;
}

function formatOpenRouterLine(p, sourceTag) {
  const name = p.displayName || "OpenRouter";
  const plan = p.plan ? ` [${p.plan}]` : "";
  const data = p.openrouter || {};
  const credits = data.credits || null;
  const key = data.key || null;

  if (p.error && !credits && !key) {
    return `• **${name}${plan}**: unavailable — ${p.error}${sourceTag}`;
  }

  const chunks = [];

  if (credits) {
    const total = credits.totalCredits;
    const used = credits.totalUsage;
    const balance = credits.balance;
    const usedPercent = credits.usedPercent;

    if (total != null && used != null) {
      chunks.push(
        `credits: $${Number(used).toFixed(2)} / $${Number(total).toFixed(2)}${
          usedPercent != null ? ` (${usedPercent}% used)` : ""
        }`
      );
    }

    if (balance != null) {
      chunks.push(`balance: $${Number(balance).toFixed(2)}`);
    }
  }

  if (key) {
    if (key.limit != null && key.usage != null && key.limit > 0) {
      const usedPercent = Math.max(0, Math.min(100, Math.round((key.usage / key.limit) * 100)));
      const leftPercent = Math.max(0, 100 - usedPercent);
      chunks.push(
        `key limit: $${Number(key.usage).toFixed(2)} / $${Number(key.limit).toFixed(2)} (${leftPercent}% left)`
      );
    }

    if (key.usageMonthly != null) chunks.push(`month: $${Number(key.usageMonthly).toFixed(2)}`);
    if (key.usageWeekly != null) chunks.push(`week: $${Number(key.usageWeekly).toFixed(2)}`);
    if (key.usageDaily != null) chunks.push(`day: $${Number(key.usageDaily).toFixed(2)}`);
  }

  const head = chunks.length
    ? `• **${name}${plan}**: ${chunks.join(" | ")}${sourceTag}`
    : `• **${name}${plan}**: no quota windows${sourceTag}`;

  const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
  if (!warnings.length) return head;
  return `${head}\n  └─ ⚠️ ${warnings.join(" · ")}`;
}

function formatSourceName(source) {
  const map = {
    "openai-codex-oauth": "OAuth API",
    "anthropic-cli-usage": "Claude /usage",
    "openclaw-status": "OpenClaw status",
    "venice-diem": "Diem API",
    "openrouter-api": "OpenRouter API",
  };
  return map[source] || source;
}

/**
 * Format a full usage report from a snapshot.
 *
 * @param {object} snapshot - from collectUsageSnapshot()
 * @param {object} opts
 * @param {string} opts.theme - "plain" | "tide"
 * @param {boolean} opts.includeEnrichment
 */
export async function formatUsageReport(snapshot, opts = {}) {
  const theme = opts.theme || "plain";
  const heading = theme === "plain" ? "📊 **Provider Quota Board**" : "🌊 **Tide Pools**";
  const includeEnrichment = opts.includeEnrichment !== false;

  const lines = [heading, "", "🛰️ **Providers**"];
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];

  if (!providers.length) {
    lines.push("• **No provider usage data found** (credentials/scope may be missing)");
  } else {
    for (const p of providers) lines.push(formatProviderLine(p));
  }

  // Enrichment section (fault-isolated)
  if (includeEnrichment && snapshot?.enrichment) {
    const enrichText = await safeFormatEnrichment(snapshot.enrichment);
    if (enrichText) lines.push("", enrichText);
  }

  return lines.join("\n");
}

// ─── Backward Compatibility ──────────────────────────────────────────────────
// These re-exports keep the CLI and plugin working during the transition.
// They can be removed in a future version once cli.mjs and index.ts are updated.

export { collectUsageSnapshot as collectUsageSnapshotV2 };
export { formatUsageReport as formatUsageReportV2 };
