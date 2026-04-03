/**
 * Tide Pool v2 — Usage Core
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
  return path.join(os.tmpdir(), "openclaw-tide-pool-cache.json");
}

function readCache(cachePath, ttlMs) {
  if (!ttlMs || ttlMs <= 0) return null;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.cachedAtMs !== "number" || !parsed.snapshot) return null;
    if (Date.now() - parsed.cachedAtMs > ttlMs) return null;
    return parsed.snapshot;
  } catch {
    return null;
  }
}

function writeCache(cachePath, snapshot) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ cachedAtMs: Date.now(), snapshot }));
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
  const cacheTtlMs = Number.isFinite(opts.cacheTtlMs)
    ? Number(opts.cacheTtlMs)
    : DEFAULT_CACHE_TTL_MS;
  const cachePath = resolveCachePath(opts.cachePath);
  const bypassCache = opts.bypassCache === true;

  // Check cache
  if (!bypassCache) {
    const cached = readCache(cachePath, cacheTtlMs);
    if (cached) {
      return {
        ...cached,
        cache: { hit: true, ttlMs: cacheTtlMs, path: cachePath },
      };
    }
  }

  // Layer 1: Adapter resolution
  const resolved = await resolveAll({ includeVenice });

  // Layer 2: Enrichment (fault-isolated)
  let enrichment = null;
  if (includeEnrichment) {
    enrichment = await safeCollectEnrichment({
      lookbackHours: opts.enrichmentLookbackHours,
    });
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    version: "2.0.0",
    providers: resolved.providers,
    adapterResults: resolved.adapterResults,
    enrichment,
  };

  // Write cache
  if (!bypassCache && cacheTtlMs > 0) writeCache(cachePath, snapshot);

  return {
    ...snapshot,
    cache: { hit: false, ttlMs: cacheTtlMs, path: cachePath },
  };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatProviderLine(p) {
  const name = p.displayName || p.provider || "Unknown provider";
  const plan = p.plan ? ` [${p.plan}]` : "";
  const sourceTag = p.source ? ` — via ${formatSourceName(p.source)}` : "";

  // Venice is special: uses Diem balance + rate limits
  if (p.provider === "venice") {
    return formatVeniceLine(p, sourceTag);
  }

  if (p.error) return `• ${name}${plan}: unavailable — ${p.error}${sourceTag}`;

  const windows = Array.isArray(p.windows) ? p.windows : [];
  if (!windows.length) return `• ${name}${plan}: no quota windows${sourceTag}`;

  const chunks = windows.map((w) => {
    const label = w.label || "window";
    const leftTxt =
      w.leftPercent != null ? `${w.leftPercent}% left` : "left unknown";
    return `${label}: ${leftTxt} (${countdown(w.resetAt)})`;
  });

  return `• ${name}${plan}: ${chunks.join(" | ")}${sourceTag}`;
}

function formatVeniceLine(p, sourceTag) {
  if (p.error && !p.diem && !p.requests && !p.tokens) {
    return `• Venice [Diem]: unavailable — ${p.error}${sourceTag}`;
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
    return `• Venice [Diem]: no balance data${sourceTag}`;
  }

  return `• Venice [Diem]: ${chunks.join(" | ")}${sourceTag}`;
}

function formatSourceName(source) {
  const map = {
    "openai-codex-oauth": "OAuth API",
    "openclaw-status": "OpenClaw status",
    "venice-diem": "Diem API",
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
  const heading = theme === "plain" ? "Provider Quota Board" : "🌊 Tide Pool";
  const includeEnrichment = opts.includeEnrichment !== false;

  const lines = [heading, ""];
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];

  if (!providers.length) {
    lines.push(
      "• No provider usage data found. (Credentials/scope may be missing.)"
    );
  } else {
    for (const p of providers) {
      lines.push(formatProviderLine(p));
    }
  }

  // Enrichment section (fault-isolated)
  if (includeEnrichment && snapshot?.enrichment) {
    const enrichText = await safeFormatEnrichment(snapshot.enrichment);
    if (enrichText) {
      lines.push(enrichText);
    }
  }

  return lines.join("\n");
}

// ─── Backward Compatibility ──────────────────────────────────────────────────
// These re-exports keep the CLI and plugin working during the transition.
// They can be removed in a future version once cli.mjs and index.ts are updated.

export { collectUsageSnapshot as collectUsageSnapshotV2 };
export { formatUsageReport as formatUsageReportV2 };
