/**
 * Adapter Registry
 *
 * Manages all source adapters and resolves the best data per provider.
 * Rules:
 *  - Direct provider adapters (e.g. openai-codex-oauth) beat generic ones (openclaw-status)
 *  - If a direct adapter fails, fall back to openclaw-status data for that provider
 *  - Every adapter runs with its own timeout + try/catch — one failure never blocks others
 *  - Venice is special (uses Diem, not standard windows) — handled in formatting
 */

import * as openclawStatus from "./openclaw-status.mjs";
import * as openaiCodexOauth from "./openai-codex-oauth.mjs";
import * as veniceDiem from "./venice-diem.mjs";

/** All registered adapters, ordered by priority (direct > generic) */
const ADAPTERS = [
  { module: openaiCodexOauth, priority: 10, direct: true },
  { module: veniceDiem, priority: 10, direct: true },
  { module: openclawStatus, priority: 0, direct: false },
];

/**
 * Run a single adapter with timeout protection.
 */
async function runAdapter(adapter, timeoutMs = 35_000) {
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
      adapter.module.probe(),
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
 * Resolve the best provider data by running all adapters and merging results.
 *
 * @param {object} opts
 * @param {boolean} opts.includeVenice - include Venice adapter (default: true)
 * @param {number}  opts.adapterTimeoutMs - per-adapter timeout (default: 15000)
 * @returns {{ providers: object[], adapterResults: object[] }}
 */
export async function resolveAll(opts = {}) {
  const includeVenice = opts.includeVenice !== false;
  const timeoutMs = opts.adapterTimeoutMs || 15_000;

  // Filter adapters
  const active = ADAPTERS.filter((a) => {
    if (!includeVenice && a.module.id === "venice-diem") return false;
    return true;
  });

  // Run all adapters in parallel
  const adapterResults = await Promise.all(
    active.map((a) => runAdapter(a, timeoutMs))
  );

  // Collect provider data, keyed by provider id
  // Direct adapters take priority; openclaw-status fills gaps
  const providerMap = new Map(); // provider -> { data, source, priority }
  const directProviders = new Set(); // providers covered by direct adapters

  // First pass: direct adapters
  for (const ar of adapterResults) {
    const adapterDef = active.find((a) => a.module.id === ar.id);
    if (!adapterDef?.direct) continue;
    if (ar.skipped || !ar.result?.available) continue;

    for (const p of ar.result.providers || []) {
      const key = p.provider;
      directProviders.add(key);
      providerMap.set(key, {
        ...p,
        source: ar.id,
        sourceType: "direct",
      });
    }
  }

  // Second pass: openclaw-status fills in anything not covered
  for (const ar of adapterResults) {
    const adapterDef = active.find((a) => a.module.id === ar.id);
    if (adapterDef?.direct) continue; // skip direct adapters
    if (ar.skipped || !ar.result?.available) continue;

    for (const p of ar.result.providers || []) {
      const key = p.provider;
      if (directProviders.has(key)) continue; // direct adapter already covers this

      // Check if it's Venice and we have a direct Venice adapter that just failed
      if (key.includes("venice") && !includeVenice) continue;

      providerMap.set(key, {
        ...p,
        source: ar.id,
        sourceType: "fallback",
      });
    }
  }

  // Convert to array, sorted: direct sources first, then fallbacks
  const providers = [...providerMap.values()].sort((a, b) => {
    if (a.sourceType === "direct" && b.sourceType !== "direct") return -1;
    if (a.sourceType !== "direct" && b.sourceType === "direct") return 1;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });

  return {
    providers,
    adapterResults: adapterResults.map((ar) => ({
      id: ar.id,
      skipped: ar.skipped,
      reason: ar.reason,
      available: ar.result?.available ?? false,
      providerCount: ar.result?.providers?.length ?? 0,
      error: ar.result?.error || null,
    })),
  };
}
