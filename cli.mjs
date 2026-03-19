#!/usr/bin/env node
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
const noCache = argv.includes("--no-cache");
const cacheTtlMsRaw = parseArgValue(argv, "--cache-ttl-ms", null);
const cacheTtlMs = cacheTtlMsRaw == null ? undefined : Number(cacheTtlMsRaw);

const snapshot = collectUsageSnapshot({
  includeVenice,
  bypassCache: noCache,
  cacheTtlMs,
});

if (format === "json") {
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(`${formatUsageReport(snapshot, { theme })}\n`);
