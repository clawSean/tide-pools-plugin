/**
 * Adapter: openrouter-api
 *
 * Fetches usage/balance directly from OpenRouter:
 *  - GET /credits (account-wide credits; management key required)
 *  - GET /key     (current API key usage + limits)
 *
 * Supports multiple auth profiles — each key/profile is probed separately
 * and returned as a distinct provider row with its own instanceId.
 *
 * Endpoint references:
 *  - https://openrouter.ai/docs/api/api-reference/credits/get-credits
 *  - https://openrouter.ai/docs/api/reference/limits
 */

import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const id = "openrouter-api";
export const provider = "openrouter";

const TIMEOUT_MS = 15_000;

function toNumber(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeBaseUrl(raw) {
  const input = String(raw || "https://openrouter.ai/api/v1").trim();
  return input.replace(/\/+$/, "");
}

/**
 * Read all usable OpenRouter API keys from env vars and auth-profiles.
 * Returns an array of profile descriptors — the actual key value is included
 * internally for probing but never exposed in public output.
 *
 * @returns {{ key: string, instanceId: string, source: string, agent?: string, profileKey?: string, label?: string }[]}
 */
function readAllApiKeys() {
  const profiles = [];
  const seenKeys = new Set();

  // Env key (one profile, labeled "env")
  const envKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENROUTER_KEY ||
    process.env.OPEN_ROUTER_API_KEY ||
    null;
  if (envKey) {
    const token = String(envKey).trim().replace(/^Bearer\s+/i, "");
    if (token && !seenKeys.has(token)) {
      seenKeys.add(token);
      profiles.push({ key: token, instanceId: "openrouter:env", source: "env", label: null });
    }
  }

  // Auth-profile keys (one per matching profile entry, deduplicated by key value)
  try {
    const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const agentsDir = path.join(openclawHome, "agents");
    if (!fs.existsSync(agentsDir)) return profiles;

    for (const agent of fs.readdirSync(agentsDir)) {
      const profilePath = path.join(agentsDir, agent, "agent", "auth-profiles.json");
      try {
        const raw = fs.readFileSync(profilePath, "utf8");
        const data = JSON.parse(raw);
        const profilesObj = data?.profiles || {};
        for (const [profileKey, entry] of Object.entries(profilesObj)) {
          if (entry?.provider !== "openrouter" || entry?.type !== "api_key" || !entry?.key) continue;
          const token = String(entry.key).trim().replace(/^Bearer\s+/i, "");
          if (!token || seenKeys.has(token)) continue;
          seenKeys.add(token);
          profiles.push({
            key: token,
            instanceId: `openrouter:profile:${agent}:${profileKey}`,
            source: "profile",
            agent,
            profileKey,
            label: entry.label || entry.name || null,
          });
        }
      } catch {
        continue;
      }
    }
  } catch {}

  return profiles;
}

/**
 * Discover all OpenRouter auth profiles (metadata only — no key values).
 * Exported for testing and dry-run inspection.
 */
export function discoverProfiles() {
  return readAllApiKeys().map(({ key: _key, ...meta }) => meta);
}

export function isAvailable() {
  return readAllApiKeys().length > 0;
}

/**
 * Fetch JSON from a URL with bearer auth. Supports both http:// and https://.
 */
function fetchJson(url, token) {
  return new Promise((resolve) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "tide-pools/2.0",
    };

    if (process.env.OPENROUTER_HTTP_REFERER) {
      headers["HTTP-Referer"] = String(process.env.OPENROUTER_HTTP_REFERER);
    }
    headers["X-Title"] = String(process.env.OPENROUTER_X_TITLE || "Tide Pools");

    let settled = false;
    let req;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      try { req?.destroy(); } catch {}
      finish({ ok: false, status: 0, data: null, error: "request timed out" });
    }, TIMEOUT_MS);

    const requester = url.startsWith("https://") ? https : http;
    req = requester.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          // keep parsed as null
        }

        const ok = res.statusCode >= 200 && res.statusCode < 300;
        finish({
          ok,
          status: res.statusCode || 0,
          data: parsed,
          error: ok
            ? null
            : parsed?.error?.message ||
              (body ? String(body).slice(0, 220) : `HTTP ${res.statusCode}`),
        });
      });
    });

    req.on("error", (err) => {
      finish({ ok: false, status: 0, data: null, error: err?.message || String(err) });
    });
  });
}

function parseCredits(data) {
  const d = data?.data || {};
  const totalCredits = toNumber(d.total_credits);
  const totalUsage = toNumber(d.total_usage);

  if (totalCredits == null && totalUsage == null) return null;

  const balance =
    totalCredits != null && totalUsage != null
      ? Math.max(0, totalCredits - totalUsage)
      : null;

  const usedPercent =
    totalCredits != null && totalCredits > 0 && totalUsage != null
      ? Math.max(0, Math.min(100, Math.round((totalUsage / totalCredits) * 100)))
      : null;

  return {
    totalCredits,
    totalUsage,
    balance,
    usedPercent,
  };
}

function parseKey(data) {
  const d = data?.data || {};
  if (!d || typeof d !== "object") return null;

  return {
    label: d.label || null,
    limit: toNumber(d.limit),
    usage: toNumber(d.usage),
    usageDaily: toNumber(d.usage_daily),
    usageWeekly: toNumber(d.usage_weekly),
    usageMonthly: toNumber(d.usage_monthly),
    byokUsage: toNumber(d.byok_usage),
    byokUsageDaily: toNumber(d.byok_usage_daily),
    byokUsageWeekly: toNumber(d.byok_usage_weekly),
    byokUsageMonthly: toNumber(d.byok_usage_monthly),
    limitRemaining: toNumber(d.limit_remaining),
    limitReset: d.limit_reset || null,
    expiresAt: d.expires_at || null,
    isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null,
    isManagementKey:
      typeof d.is_management_key === "boolean" ? d.is_management_key : null,
    rateLimit: d.rate_limit || null,
  };
}

function buildWindows(credits, key) {
  const windows = [];

  if (credits && credits.totalCredits != null && credits.totalUsage != null) {
    windows.push({
      label: "credits",
      used: credits.totalUsage,
      limit: credits.totalCredits,
      remaining: credits.balance,
      usedPercent: credits.usedPercent,
      leftPercent:
        credits.usedPercent != null ? Math.max(0, 100 - credits.usedPercent) : null,
      resetAt: null,
    });
  }

  if (key && key.limit != null && key.usage != null && key.limit > 0) {
    const usedPercent = Math.max(0, Math.min(100, Math.round((key.usage / key.limit) * 100)));
    windows.push({
      label: "key-limit",
      used: key.usage,
      limit: key.limit,
      remaining:
        key.limitRemaining != null ? key.limitRemaining : Math.max(0, key.limit - key.usage),
      usedPercent,
      leftPercent: Math.max(0, 100 - usedPercent),
      resetAt: null,
      resetPolicy: key.limitReset || null,
    });
  }

  return windows;
}

/**
 * Probe a single key and return a provider entry, or null if the key fails.
 */
async function probeOneKey(base, { key, instanceId, source: keySource, agent, profileKey, label }) {
  const [creditsRes, keyRes] = await Promise.all([
    fetchJson(`${base}/credits`, key),
    fetchJson(`${base}/key`, key),
  ]);

  const credits = creditsRes.ok ? parseCredits(creditsRes.data) : null;
  const keyData = keyRes.ok ? parseKey(keyRes.data) : null;

  const nameHint = label || agent || profileKey || instanceId;
  if (!credits && !keyData) {
    return {
      provider: null,
      instanceId,
      error: `${nameHint}: credits ${creditsRes.status || "ERR"} ${creditsRes.error || "failed"}; key ${keyRes.status || "ERR"} ${keyRes.error || "failed"}`,
    };
  }

  const windows = buildWindows(credits, keyData);

  const plan =
    keyData?.isFreeTier === true
      ? "free-tier"
      : keyData?.isManagementKey === true
        ? "management-key"
        : null;

  const warnings = [];
  if (!creditsRes.ok) {
    warnings.push(
      `credits unavailable (${creditsRes.status || "ERR"}: ${creditsRes.error || "failed"})`
    );
  }

  let displayName = "OpenRouter";
  if (keySource === "profile") {
    if (nameHint) displayName = `OpenRouter [${nameHint}]`;
  }

  return {
    provider: "openrouter",
    instanceId,
    displayName,
    plan,
    windows,
    error: null,
    openrouter: {
      credits,
      key: keyData,
      warnings,
    },
    meta: {
      source: keySource,
      agent: agent || null,
      profileKey: profileKey || null,
      label: label || null,
    },
  };
}

export async function probe() {
  try {
    const allKeys = readAllApiKeys();
    if (!allKeys.length) {
      return {
        available: false,
        providers: [],
        error: "No OpenRouter API key found (env or auth-profiles)",
        source: id,
      };
    }

    const base = normalizeBaseUrl(process.env.OPENROUTER_API_URL);

    const settled = await Promise.all(
      allKeys.map((profile) =>
        probeOneKey(base, profile).catch((err) => ({
          provider: null,
          instanceId: profile.instanceId,
          error: `${profile.label || profile.agent || profile.profileKey || profile.instanceId}: ${err?.message || String(err)}`,
        }))
      )
    );

    const providers = settled.filter((entry) => entry?.provider);
    const keyErrors = settled.filter((entry) => !entry?.provider && entry?.error).map((entry) => entry.error);

    if (!providers.length) {
      return {
        available: false,
        providers: [],
        error: keyErrors.length
          ? `All OpenRouter keys failed: ${keyErrors.join(" | ")}`
          : "All OpenRouter keys failed (credits and key endpoints unavailable)",
        source: id,
      };
    }

    return {
      available: true,
      providers,
      error: keyErrors.length ? `${keyErrors.length} OpenRouter profile(s) failed` : null,
      warnings: keyErrors,
      source: id,
    };
  } catch (err) {
    return {
      available: false,
      providers: [],
      error: `OpenRouter probe failed: ${err?.message || String(err)}`,
      source: id,
    };
  }
}
