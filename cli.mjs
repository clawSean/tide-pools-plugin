#!/usr/bin/env node

/**
 * Tide Pools CLI v2
 *
 * Usage:
 *   tide-pools [options]
 *
 * Options:
 *   --format text|json    Output format (default: text)
 *   --theme plain|tide    Report theme (default: plain)
 *   --no-venice           Skip Venice/Diem probe
 *   --no-enrich           Skip session JSONL enrichment
 *   --no-cache            Bypass cache
 *   --cache-ttl-ms N      Override cache TTL in ms (default: 45000)
 *   --lookback-hours N    Enrichment lookback period (default: 24)
 *   --anthropic-source auto|api|subscription
 *                        Anthropic source selection (default: auto)
 */

import { collectUsageSnapshot, formatUsageReport } from "./usage-core.mjs";

function parseArgValue(argv, key, fallback = null) {
  const i = argv.indexOf(key);
  if (i === -1) return fallback;
  return argv[i + 1] ?? fallback;
}

const argv = process.argv.slice(2);
const format = parseArgValue(argv, "--format", "text");
const theme = parseArgValue(argv, "--theme", "plain");
const includeVenice = !argv.includes("--no-venice");
const includeEnrichment = !argv.includes("--no-enrich");
const noCache = argv.includes("--no-cache");
const cacheTtlMsRaw = parseArgValue(argv, "--cache-ttl-ms", null);
const cacheTtlMs = cacheTtlMsRaw == null ? undefined : Number(cacheTtlMsRaw);
const lookbackRaw = parseArgValue(argv, "--lookback-hours", null);
const lookbackHours = lookbackRaw == null ? undefined : Number(lookbackRaw);
const anthropicSourceRaw = String(parseArgValue(argv, "--anthropic-source", "auto") || "auto").toLowerCase();
const anthropicSource = ["auto", "api", "subscription"].includes(anthropicSourceRaw)
  ? anthropicSourceRaw
  : "auto";

async function main() {
  const snapshot = await collectUsageSnapshot({
    includeVenice,
    includeEnrichment,
    bypassCache: noCache,
    cacheTtlMs,
    enrichmentLookbackHours: lookbackHours,
    anthropicSource,
  });

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    process.exit(0);
  }

  const report = await formatUsageReport(snapshot, {
    theme,
    includeEnrichment,
  });
  process.stdout.write(`${report}\n`);
}

main().then(() => process.exit(0)).catch((err) => {
  process.stderr.write(`Tide Pools error: ${err?.message || String(err)}\n`);
  process.exit(1);
});
