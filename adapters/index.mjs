/**
 * Adapter Registry
 *
 * Manages all source adapters and resolves the best data per provider.
 * Rules:
 *  - Direct provider adapters (e.g. openai-codex-oauth, anthropic-cli-usage) beat generic ones (openclaw-status)
 *  - If a direct adapter fails, fall back to openclaw-status data for that provider
 *  - Every adapter runs with its own timeout + try/catch — one failure never blocks others
 *  - Venice is special (uses Diem, not standard windows) — handled in formatting
 */

import * as openclawStatus from "./openclaw-status.mjs";
import * as openaiCodexOauth from "./openai-codex-oauth.mjs";
import * as anthropicCliUsage from "./anthropic-cli-usage.mjs";
import * as openrouterApi from "./openrouter-api.mjs";
import * as veniceDiem from "./venice-diem.mjs";

/** All registered adapters, ordered by priority (direct > generic) */
const ADAPTERS = [
  { module: openaiCodexOauth, priority: 10, direct: true },
  { module: anthropicCliUsage, priority: 10, direct: true },
  { module: openrouterApi, priority: 10, direct: true },
  { module: veniceDiem, priority: 10, direct: true },
  { module: openclawStatus, priority: 0, direct: false },
];

/**
 * Run a single adapter with timeout protection.
 */
async function runAdapter(adapter, timeoutMs = 35_000, context = {}) {
  try {
    if (!adapter.module.isAvailable()) {
      return {
        id: adapter.module.id,
        skipped: true,
        reason: "not available",
        result: null,
      };
    }

    const result = await Promise.race([
      adapter.module.probe(context),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Adapter timed out")), timeoutMs)
      ),
    ]);

    return {
      id: adapter.module.id,
      skipped: false,
      reason: null,
      result,
    };
  } catch (err) {
    return {
      id: adapter.module.id,
      skipped: false,
      reason: `error: ${err?.message || String(err)}`,
      result: {
        available: false,
        providers: [],
        error: err?.message || String(err),
        source: adapter.module.id,
      },
    };
  }
}

/**
 * Merge fallback adapter results into the provider map for any providers
 * not already covered by direct adapters.
 */
function mergeFallback(fallbackResult, providerMap, directProviders, includeVenice) {
  if (!fallbackResult || fallbackResult.skipped || !fallbackResult.result?.available) return;

  for (const p of fallbackResult.result.providers || []) {
    const key = p.provider;
    if (directProviders.has(key)) continue;
    if (key.includes("venice") && !includeVenice) continue;

    providerMap.set(key, {
      ...p,
      source: fallbackResult.id,
      sourceType: "fallback",
    });
  }
}

/**
 * Resolve the best provider data by running all adapters and merging results.
 *
 * Direct adapters run first (truly in parallel). The openclaw-status fallback
 * fires concurrently but is only awaited if a direct adapter leaves a gap —
 * otherwise it finishes silently in the background.
 *
 * @param {object} opts
 * @param {boolean} opts.includeVenice - include Venice adapter (default: true)
 * @param {number}  opts.adapterTimeoutMs - per-adapter timeout (default: 15000)
 * @returns {{ providers: object[], adapterResults: object[] }}
 */
export async function resolveAll(opts = {}) {
  const includeVenice = opts.includeVenice !== false;
  const timeoutMs = opts.adapterTimeoutMs || 25_000;
  const anthropicSource = String(opts.anthropicSource || "auto").toLowerCase();

  const directAdapters = ADAPTERS.filter((a) => {
    if (!a.direct) return false;
    if (!includeVenice && a.module.id === "venice-diem") return false;
    if (anthropicSource === "api" && a.module.id === "anthropic-cli-usage") return false;
    return true;
  });

  const fallbackAdapter = ADAPTERS.find((a) => !a.direct);

  // Fire the fallback concurrently with an AbortController so we can
  // kill the child process if direct adapters cover everything.
  const fallbackAc = new AbortController();
  const fallbackPromise = fallbackAdapter
    ? runAdapter(fallbackAdapter, timeoutMs, { anthropicSource, signal: fallbackAc.signal }).catch(() => null)
    : null;

  // Run all direct adapters in parallel and wait for them
  const directResults = await Promise.all(
    directAdapters.map((a) => runAdapter(a, timeoutMs, { anthropicSource }))
  );

  // Collect direct provider data
  const providerMap = new Map();
  const directProviders = new Set();

  for (const ar of directResults) {
    if (ar.skipped || !ar.result?.available) continue;
    for (const p of ar.result.providers || []) {
      directProviders.add(p.provider);
      providerMap.set(p.provider, { ...p, source: ar.id, sourceType: "direct" });
    }
  }

  // Check if any direct adapter failed to produce its provider
  const expectedProviders = directAdapters
    .filter((a) => !directResults.find((r) => r.id === a.module.id)?.skipped)
    .map((a) => a.module.provider);
  const hasGap = expectedProviders.some((p) => !directProviders.has(p));

  if (hasGap && fallbackPromise) {
    const fallbackResult = await fallbackPromise;
    mergeFallback(fallbackResult, providerMap, directProviders, includeVenice);
  } else {
    // No gap — kill the fallback's child process so it doesn't hold the event loop open
    fallbackAc.abort();
  }

  const providers = [...providerMap.values()].sort((a, b) => {
    if (a.sourceType === "direct" && b.sourceType !== "direct") return -1;
    if (a.sourceType !== "direct" && b.sourceType === "direct") return 1;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });

  const allResults = [...directResults];
  return {
    providers,
    adapterResults: allResults.map((ar) => ({
      id: ar.id,
      skipped: ar.skipped,
      reason: ar.reason,
      available: ar.result?.available ?? false,
      providerCount: ar.result?.providers?.length ?? 0,
      error: ar.result?.error || null,
    })),
  };
}
