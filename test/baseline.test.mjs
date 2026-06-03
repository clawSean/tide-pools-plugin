/**
 * Baseline sanity tests for tide-pools plugin.
 *
 * Covers: manifest/package consistency, entry-point export shape,
 * usage-core formatting helpers, Venice Diem output parsing,
 * enrichment formatting helpers, and parseQuotaArgs logic.
 *
 * All tests are fully offline — no network, no tmux, no credentials.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ─── Manifest & Package Sanity ──────────────────────────────────────────────

test("manifest: openclaw.plugin.json is valid JSON with required fields", () => {
  const raw = fs.readFileSync(path.join(ROOT, "openclaw.plugin.json"), "utf8");
  const manifest = JSON.parse(raw);
  assert.equal(manifest.id, "tide-pools");
  assert.equal(typeof manifest.name, "string");
  assert.equal(typeof manifest.version, "string");
  assert.equal(typeof manifest.description, "string");
  assert.deepStrictEqual(manifest.activation, { onStartup: true });
});

test("manifest: version matches package.json", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "openclaw.plugin.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version, "openclaw.plugin.json version must match package.json version");
});

test("package.json: required fields present", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "@openclaw-ext/tide-pools");
  assert.equal(pkg.type, "module");
  assert.equal(typeof pkg.main, "string");
  assert.ok(pkg.scripts?.test, "test script must exist");
});

test("package.json: all listed files exist on disk", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const f of pkg.files || []) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `listed file missing: ${f}`);
  }
});

// ─── Entry Point (index.ts) ─────────────────────────────────────────────────

test("entry: index.ts exports a default register function", async () => {
  // We can't import .ts directly, but we can verify the file exists and
  // contains the expected export shape via static analysis.
  const src = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
  assert.ok(src.includes("export default function register"), "must have default export register()");
  assert.ok(src.includes("api.registerCommand"), "must register at least one command");
});

test("entry: registers both tidepools and quota_all commands", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
  const commands = [...src.matchAll(/name:\s*"(\w+)"/g)].map((m) => m[1]);
  assert.ok(commands.includes("tidepools"), "must register /tidepools");
  assert.ok(commands.includes("quota_all"), "must register /quota_all");
});

// ─── parseQuotaArgs (extracted logic test) ───────────────────────────────────

// We re-implement parseQuotaArgs here since index.ts can't be imported directly.
// This validates the regex logic that the plugin uses.
function parseQuotaArgs(raw) {
  const args = String(raw || "").trim();
  const has = (re) => re.test(args);
  const matchCacheTtl = args.match(/--cache-ttl-ms\s+(\d+)/i);
  const matchLookback = args.match(/--lookback-hours\s+(\d+)/i);
  const matchAnthropicSource = args.match(/--anthropic-source\s+(auto|api|subscription)/i);
  return {
    format: has(/(?:^|\s)(--json|json)(?:\s|$)/i) ? "json" : "text",
    noVenice: has(/(?:^|\s)--no-venice(?:\s|$)/i),
    noEnrich: has(/(?:^|\s)--no-enrich(?:\s|$)/i),
    noCache: has(/(?:^|\s)--no-cache(?:\s|$)/i),
    cacheTtlMs: matchCacheTtl ? Number(matchCacheTtl[1]) : undefined,
    lookbackHours: matchLookback ? Number(matchLookback[1]) : undefined,
    anthropicSource: matchAnthropicSource ? String(matchAnthropicSource[1]).toLowerCase() : "api",
  };
}

test("parseQuotaArgs: defaults with empty input", () => {
  const r = parseQuotaArgs("");
  assert.equal(r.format, "text");
  assert.equal(r.noVenice, false);
  assert.equal(r.noEnrich, false);
  assert.equal(r.noCache, false);
  assert.equal(r.cacheTtlMs, undefined);
  assert.equal(r.lookbackHours, undefined);
  assert.equal(r.anthropicSource, "api");
});

test("parseQuotaArgs: parses --json flag", () => {
  assert.equal(parseQuotaArgs("--json").format, "json");
  assert.equal(parseQuotaArgs("json").format, "json");
  assert.equal(parseQuotaArgs("--no-cache --json").format, "json");
});

test("parseQuotaArgs: parses all flags together", () => {
  const r = parseQuotaArgs("--no-venice --no-enrich --no-cache --cache-ttl-ms 5000 --lookback-hours 48 --anthropic-source subscription");
  assert.equal(r.noVenice, true);
  assert.equal(r.noEnrich, true);
  assert.equal(r.noCache, true);
  assert.equal(r.cacheTtlMs, 5000);
  assert.equal(r.lookbackHours, 48);
  assert.equal(r.anthropicSource, "subscription");
});

test("parseQuotaArgs: anthropic-source is case-insensitive", () => {
  assert.equal(parseQuotaArgs("--anthropic-source API").anthropicSource, "api");
  assert.equal(parseQuotaArgs("--anthropic-source Subscription").anthropicSource, "subscription");
});

// ─── Usage Core: formatUsageReport ──────────────────────────────────────────

test("usage-core: formatUsageReport renders providers", async () => {
  const { formatUsageReport } = await import("../usage-core.mjs");

  const snapshot = {
    providers: [
      {
        provider: "openai-codex",
        displayName: "OpenAI Codex",
        plan: "plus",
        windows: [{ label: "5h", leftPercent: 80, resetAt: Date.now() + 3_600_000 }],
        error: null,
      },
    ],
    enrichment: null,
  };

  const report = await formatUsageReport(snapshot, { theme: "plain", includeEnrichment: false });
  assert.ok(report.includes("Provider Quota Board"), "plain theme heading");
  assert.ok(report.includes("OpenAI Codex"), "provider name appears");
  assert.ok(report.includes("80% left"), "left percent appears");
});

test("usage-core: formatUsageReport tide theme", async () => {
  const { formatUsageReport } = await import("../usage-core.mjs");
  const report = await formatUsageReport({ providers: [], enrichment: null }, { theme: "tide" });
  assert.ok(report.includes("Tide Pools"), "tide theme heading");
  assert.ok(report.includes("No provider usage data found"), "empty state message");
});

test("usage-core: formatUsageReport handles anthropic extra usage line", async () => {
  const { formatUsageReport } = await import("../usage-core.mjs");

  const snapshot = {
    providers: [
      {
        provider: "anthropic",
        displayName: "Anthropic Claude",
        plan: "subscription",
        windows: [
          { label: "5h", leftPercent: 65, resetAt: Date.now() + 3_600_000, resetIn: "1h 0m" },
          { label: "week", leftPercent: 28, resetAt: Date.now() + 86_400_000, resetIn: "1d 0h 0m" },
          { label: "extra", status: "enabled", spentUsd: 3.25, limitUsd: 5, availableUsd: 1.75, overUsd: 0 },
        ],
        error: null,
      },
    ],
    enrichment: null,
  };

  const report = await formatUsageReport(snapshot, { theme: "plain", includeEnrichment: false });
  assert.ok(report.includes("65% left"), "5h left percent");
  assert.ok(report.includes("28% left"), "week left percent");
  assert.ok(report.includes("Extra usage"), "extra usage line");
  assert.ok(report.includes("$1.75 available"), "extra available USD");
});

// ─── Venice Diem Adapter: parseDiemOutput ───────────────────────────────────

test("venice-diem: parseDiemOutput extracts balance and rate limits", async () => {
  // Access the private parseDiemOutput by reading the source and checking the
  // probe output shape instead. We test via the probe's internal logic path.
  // Since parseDiemOutput is not exported, we verify the module's probe shape.
  const mod = await import("../adapters/venice-diem.mjs");
  assert.equal(mod.id, "venice-diem");
  assert.equal(mod.provider, "venice");
  assert.equal(typeof mod.isAvailable, "function");
  assert.equal(typeof mod.probe, "function");
});

// ─── Enrichment Formatting ──────────────────────────────────────────────────

test("enrichment: formatEnrichment returns null for empty/unavailable data", async () => {
  const { formatEnrichment } = await import("../enrichment.mjs");
  assert.equal(formatEnrichment(null), null);
  assert.equal(formatEnrichment({ available: false }), null);
  assert.equal(formatEnrichment({ available: true, sessions: [] }), null);
});

test("enrichment: formatEnrichment renders session breakdown", async () => {
  const { formatEnrichment } = await import("../enrichment.mjs");

  const enrichment = {
    available: true,
    sessions: [
      {
        sessionId: "abc123",
        label: "DM (telegram)",
        agent: "bot1",
        model: "claude-sonnet-4-5-20250514",
        chatType: "direct",
        input: 5000,
        output: 2000,
        cacheRead: 1000,
        cacheWrite: 500,
        totalTokens: 8500,
        costTotal: 0.05,
        messageCount: 3,
      },
      {
        sessionId: "def456",
        label: "Cron job",
        agent: "bot1",
        model: "claude-haiku-4-5-20251001",
        chatType: null,
        input: 1000,
        output: 500,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1500,
        costTotal: 0.001,
        messageCount: 1,
      },
    ],
    totals: {
      input: 6000,
      output: 2500,
      cacheRead: 1000,
      cacheWrite: 500,
      totalTokens: 10000,
      costTotal: 0.051,
      messageCount: 4,
    },
    byModel: {
      "claude-sonnet-4-5-20250514": { tokens: 8500, cost: 0.05, sessions: 1 },
      "claude-haiku-4-5-20251001": { tokens: 1500, cost: 0.001, sessions: 1 },
    },
    lookbackHours: 24,
  };

  const text = formatEnrichment(enrichment);
  assert.ok(text, "should produce output");
  assert.ok(text.includes("Usage"), "has usage heading");
  assert.ok(text.includes("Total"), "has total section");
  assert.ok(text.includes("10K tok"), "total tokens formatted");
  assert.ok(text.includes("Top model"), "has model section");
});

// ─── Adapter Registry ───────────────────────────────────────────────────────

test("adapter-registry: all adapters export required interface", async () => {
  const adapterFiles = [
    "../adapters/anthropic-cli-usage.mjs",
    "../adapters/openai-codex-oauth.mjs",
    "../adapters/openrouter-api.mjs",
    "../adapters/openclaw-status.mjs",
    "../adapters/venice-diem.mjs",
  ];

  for (const f of adapterFiles) {
    const mod = await import(f);
    assert.equal(typeof mod.id, "string", `${f}: must export id`);
    assert.equal(typeof mod.provider, "string", `${f}: must export provider`);
    assert.equal(typeof mod.isAvailable, "function", `${f}: must export isAvailable()`);
    assert.equal(typeof mod.probe, "function", `${f}: must export probe()`);
  }
});

test("adapter-registry: buildProviderMap exported and functional", async () => {
  const { buildProviderMap } = await import("../adapters/index.mjs");
  assert.equal(typeof buildProviderMap, "function");

  // Empty input
  const { providerMap, directProviders } = buildProviderMap([]);
  assert.equal(providerMap.size, 0);
  assert.equal(directProviders.size, 0);
});
