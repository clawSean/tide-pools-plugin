/**
 * Tests: multi-profile same-provider-kind support
 *
 * Proves that distinct auth profiles for the same provider kind (e.g. two
 * OpenRouter API keys) each appear as separate rows instead of collapsing.
 *
 * Tests are fully offline except for test 4, which uses a local http server.
 * All fixtures are synthetic temp dirs — no real secrets are read or printed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makeTempOpenclawHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tide-pools-test-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function writeAuthProfile(openclawHome, agentName, profileKey, entry) {
  const agentDir = path.join(openclawHome, "agents", agentName, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const filePath = path.join(agentDir, "auth-profiles.json");
  let data = { profiles: {} };
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
  data.profiles[profileKey] = entry;
  fs.writeFileSync(filePath, JSON.stringify(data));
}

/** Save a set of env vars and return a restore function. */
function saveEnv(keys) {
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ─── Test 1: OpenRouter discoverProfiles finds multiple auth-profile entries ─

test("openrouter: discoverProfiles returns one entry per unique auth-profile key", async (t) => {
  const dir = makeTempOpenclawHome();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeAuthProfile(dir, "agent1", "or_profile_a", {
    provider: "openrouter",
    type: "api_key",
    key: "sk-or-test-key-aaaa",
    label: "Personal",
  });
  writeAuthProfile(dir, "agent2", "or_profile_b", {
    provider: "openrouter",
    type: "api_key",
    key: "sk-or-test-key-bbbb",
    label: "Work",
  });

  const restore = saveEnv(["OPENCLAW_HOME", "OPENROUTER_API_KEY", "OPENROUTER_KEY", "OPEN_ROUTER_API_KEY"]);
  t.after(restore);

  process.env.OPENCLAW_HOME = dir;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  delete process.env.OPEN_ROUTER_API_KEY;

  const { discoverProfiles } = await import("../adapters/openrouter-api.mjs");
  const profiles = discoverProfiles();

  assert.strictEqual(profiles.length, 2, "should find 2 profiles");
  assert.ok(profiles.every((p) => p.instanceId !== undefined), "each profile has instanceId");
  const ids = profiles.map((p) => p.instanceId);
  assert.strictEqual(new Set(ids).size, 2, "instanceIds must be distinct");
  // Key values must NOT appear in metadata
  assert.ok(profiles.every((p) => p.key === undefined), "key value must not be exposed");
});

// ─── Test 2: OpenAI Codex discoverProfiles finds multiple OAuth profiles ─────

test("openai-codex: discoverProfiles returns one entry per unique non-expired profile", async (t) => {
  const dir = makeTempOpenclawHome();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const futureExpiry = Date.now() + 3_600_000; // 1 hour from now

  writeAuthProfile(dir, "agent1", "codex_profile_a", {
    provider: "openai-codex",
    type: "oauth",
    access: "tok-test-aaaa",
    expires: futureExpiry,
    label: "Alice",
  });
  writeAuthProfile(dir, "agent2", "codex_profile_b", {
    provider: "openai-codex",
    type: "oauth",
    access: "tok-test-bbbb",
    expires: futureExpiry,
    label: "Bob",
  });
  // Current OpenClaw stores ChatGPT OAuth profiles as provider: "openai".
  writeAuthProfile(dir, "agent4", "openai:charlie@example.com", {
    provider: "openai",
    type: "oauth",
    access: "tok-test-cccc",
    expires: futureExpiry,
    email: "charlie@example.com",
    accountId: "acct-charlie",
    chatgptPlanType: "plus",
  });
  // Expired profile — must be excluded
  writeAuthProfile(dir, "agent3", "codex_profile_expired", {
    provider: "openai-codex",
    type: "oauth",
    access: "tok-test-expired",
    expires: 1, // epoch past
    label: "Expired",
  });

  const restore = saveEnv(["OPENCLAW_HOME"]);
  t.after(restore);
  process.env.OPENCLAW_HOME = dir;

  // Ensure no local ~/.codex/auth.json bleeds into this test (it's read at call time)
  // We can't easily override AUTH_PATH, but discoverProfiles only reads it if it exists.
  // As long as the fixture home has the right profiles, the assertions hold for profile entries.

  const { discoverProfiles } = await import("../adapters/openai-codex-oauth.mjs");
  const profiles = discoverProfiles();

  const profileEntries = profiles.filter((p) => p.source === "profile");
  assert.strictEqual(profileEntries.length, 3, "should find 3 non-expired profile entries");

  const ids = profileEntries.map((p) => p.instanceId);
  assert.strictEqual(new Set(ids).size, 3, "instanceIds must be distinct");
  assert.ok(profileEntries.every((p) => p.token === undefined), "token must not be exposed");
  assert.ok(
    profileEntries.some((p) => p.profileKey === "openai:charlie@example.com" && p.accountPlan === "plus"),
    "current OpenClaw provider: openai OAuth profile should be accepted"
  );
});

test("openai-codex: empty local auth file is unavailable", async (t) => {
  const dir = makeTempOpenclawHome();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tide-pools-fake-home-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".codex", "auth.json"), JSON.stringify({}));

  const restore = saveEnv(["OPENCLAW_HOME", "HOME"]);
  t.after(restore);
  process.env.OPENCLAW_HOME = dir;
  process.env.HOME = fakeHome;

  const { discoverProfiles, isAvailable, probe } = await import(`../adapters/openai-codex-oauth.mjs?emptyAuth=${Date.now()}`);
  assert.equal(discoverProfiles().length, 0);
  assert.equal(isAvailable(), false);

  const result = await probe();
  assert.equal(result.available, false);
  assert.match(result.error, /No ChatGPT\/OpenAI OAuth credentials/);
});

// ─── Test 3: Registry buildProviderMap preserves same-kind providers ──────────

test("registry: buildProviderMap preserves distinct same-provider-kind rows", async () => {
  const { buildProviderMap } = await import("../adapters/index.mjs");

  const fakeResults = [
    {
      id: "openrouter-api",
      skipped: false,
      reason: null,
      result: {
        available: true,
        providers: [
          {
            provider: "openrouter",
            instanceId: "openrouter:env",
            displayName: "OpenRouter",
            windows: [],
          },
          {
            provider: "openrouter",
            instanceId: "openrouter:profile:agent1:or_a",
            displayName: "OpenRouter [Personal]",
            windows: [],
          },
        ],
      },
    },
  ];

  const { providerMap, directProviders } = buildProviderMap(fakeResults);

  assert.strictEqual(providerMap.size, 2, "both openrouter instances must survive in the map");
  assert.ok(directProviders.has("openrouter"), "provider kind 'openrouter' must be tracked");

  const rows = [...providerMap.values()];
  const instIds = rows.map((r) => r.instanceId);
  assert.ok(instIds.includes("openrouter:env"), "env row present");
  assert.ok(instIds.includes("openrouter:profile:agent1:or_a"), "profile row present");
  assert.ok(rows.every((r) => r.sourceType === "direct"), "all rows tagged as direct");
});

// ─── Test 4: OpenRouter probe returns multiple providers (local HTTP server) ──

test("openrouter: probe returns one provider row per key against a local HTTP server", async (t) => {
  // Start a minimal HTTP server that returns valid OpenRouter API responses
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/credits") {
      res.end(JSON.stringify({ data: { total_credits: 100, total_usage: 20 } }));
    } else if (req.url === "/key") {
      res.end(JSON.stringify({ data: { limit: 50, usage: 5, is_free_tier: false } }));
    } else {
      res.end(JSON.stringify({}));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const dir = makeTempOpenclawHome();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeAuthProfile(dir, "agent1", "or_profile_a", {
    provider: "openrouter",
    type: "api_key",
    key: "sk-or-test-key-profile-a",
    label: "Profile A",
  });
  writeAuthProfile(dir, "agent2", "or_profile_b", {
    provider: "openrouter",
    type: "api_key",
    key: "sk-or-test-key-profile-b",
    label: "Profile B",
  });

  const restore = saveEnv([
    "OPENCLAW_HOME",
    "OPENROUTER_API_URL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_KEY",
    "OPEN_ROUTER_API_KEY",
  ]);
  t.after(restore);

  process.env.OPENCLAW_HOME = dir;
  process.env.OPENROUTER_API_URL = `http://127.0.0.1:${port}`;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  delete process.env.OPEN_ROUTER_API_KEY;

  const { probe } = await import("../adapters/openrouter-api.mjs");
  const result = await probe();

  assert.strictEqual(result.available, true, "probe should succeed");
  assert.strictEqual(result.providers.length, 2, "should return 2 provider rows");
  assert.ok(
    result.providers.every((p) => p.provider === "openrouter"),
    "all rows have provider kind 'openrouter'"
  );
  const instIds = result.providers.map((p) => p.instanceId);
  assert.strictEqual(new Set(instIds).size, 2, "instanceIds must be distinct");
  assert.ok(
    result.providers.every((p) => p.instanceId.startsWith("openrouter:profile:")),
    "all rows should be profile-sourced"
  );
  // No key values in output
  assert.ok(
    result.providers.every((p) => p.key === undefined),
    "key values must not appear in provider rows"
  );
});

// ─── Test 5: OpenAI Codex probe returns multiple profile rows (local server) ─

test("openai-codex: probe returns one provider row per OAuth profile against a local HTTP server", async (t) => {
  const seenAccountIds = [];
  const server = http.createServer((req, res) => {
    const accountId = req.headers["chatgpt-account-id"] || null;
    seenAccountIds.push(accountId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      account_id: accountId,
      plan_type: accountId === "acct-team" ? "team" : "plus",
      rate_limit: {
        primary_window: {
          used_percent: accountId === "acct-team" ? 10 : 20,
          limit_window_seconds: 18_000,
          reset_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const dir = makeTempOpenclawHome();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tide-pools-fake-home-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const futureExpiry = Date.now() + 3_600_000;
  writeAuthProfile(dir, "agent1", "codex_profile_a", {
    provider: "openai-codex",
    type: "oauth",
    access: "tok-test-shared",
    expires: futureExpiry,
    label: "Codex A",
    accountId: "acct-team",
  });
  writeAuthProfile(dir, "agent2", "codex_profile_b", {
    provider: "openai-codex",
    type: "oauth",
    access: "tok-test-shared",
    expires: futureExpiry,
    label: "Codex B",
    accountId: "acct-plus",
  });
  writeAuthProfile(dir, "agent3", "openai:charlie@example.com", {
    provider: "openai",
    type: "oauth",
    access: "tok-test-openai",
    expires: futureExpiry,
    email: "charlie@example.com",
    accountId: "acct-openai",
    chatgptPlanType: "plus",
  });

  const restore = saveEnv(["OPENCLAW_HOME", "CODEX_WHAM_URL", "HOME"]);
  t.after(restore);

  process.env.OPENCLAW_HOME = dir;
  process.env.CODEX_WHAM_URL = `http://127.0.0.1:${port}/usage`;
  process.env.HOME = fakeHome;

  const { probe } = await import(`../adapters/openai-codex-oauth.mjs?codexProbe=${Date.now()}`);
  const result = await probe();

  assert.strictEqual(result.available, true, "probe should succeed");
  assert.strictEqual(result.providers.length, 3, "should return 3 provider rows");
  assert.ok(result.providers.every((p) => p.provider === "openai"));
  const instIds = result.providers.map((p) => p.instanceId);
  assert.strictEqual(new Set(instIds).size, 3, "instanceIds must be distinct");
  assert.ok(result.providers.every((p) => p.instanceId.startsWith("openai-codex:profile:")));
  assert.deepStrictEqual(new Set(result.providers.map((p) => p.plan)), new Set(["team", "plus"]));
  assert.deepStrictEqual(new Set(seenAccountIds), new Set(["acct-team", "acct-plus", "acct-openai"]));
  assert.ok(result.providers.every((p) => p.token === undefined), "tokens must not appear in provider rows");
});
