/**
 * Adapter: openrouter-api
 *
 * Fetches usage/balance directly from OpenRouter:
 *  - GET /credits (account-wide credits; management key required)
 *  - GET /key     (current API key usage + limits)
 *
 * Endpoint references:
 *  - https://openrouter.ai/docs/api/api-reference/credits/get-credits
 *  - https://openrouter.ai/docs/api/reference/limits
 */

import https from "node:https";
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
 * Try to read the OpenRouter API key from OpenClaw's auth-profiles.json.
 * Scans all agent directories for an openrouter profile with type "api_key".
 */
function readKeyFromAuthProfiles() {
  try {
    const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const agentsDir = path.join(openclawHome, "agents");
    if (!fs.existsSync(agentsDir)) return null;

    for (const agent of fs.readdirSync(agentsDir)) {
      const profilePath = path.join(agentsDir, agent, "agent", "auth-profiles.json");
      try {
        const raw = fs.readFileSync(profilePath, "utf8");
        const data = JSON.parse(raw);
        const profiles = data?.profiles || {};
        for (const entry of Object.values(profiles)) {
          if (entry?.provider === "openrouter" && entry?.type === "api_key" && entry?.key) {
            return String(entry.key).trim();
          }
        }
      } catch {
        continue;
      }
    }
  } catch {}
  return null;
}

function readApiKey() {
  const envKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENROUTER_KEY ||
    process.env.OPEN_ROUTER_API_KEY ||
    null;

  if (envKey) {
    const token = String(envKey).trim();
    if (token) return token.replace(/^Bearer\s+/i, "");
  }

  return readKeyFromAuthProfiles();
}

export function isAvailable() {
  return Boolean(readApiKey());
}

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

    const timeout = setTimeout(() => {
      resolve({ ok: false, status: 0, data: null, error: "request timed out" });
    }, TIMEOUT_MS);

    const req = https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        clearTimeout(timeout);

        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          // keep parsed as null
        }

        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({
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
      clearTimeout(timeout);
      resolve({ ok: false, status: 0, data: null, error: err?.message || String(err) });
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

export async function probe() {
  try {
    const token = readApiKey();
    if (!token) {
      return {
        available: false,
        providers: [],
        error: "OPENROUTER_API_KEY not set",
        source: id,
      };
    }

    const base = normalizeBaseUrl(process.env.OPENROUTER_API_URL);

    const [creditsRes, keyRes] = await Promise.all([
      fetchJson(`${base}/credits`, token),
      fetchJson(`${base}/key`, token),
    ]);

    const credits = creditsRes.ok ? parseCredits(creditsRes.data) : null;
    const key = keyRes.ok ? parseKey(keyRes.data) : null;

    if (!credits && !key) {
      const parts = [];
      if (!creditsRes.ok) {
        parts.push(
          `credits ${creditsRes.status || "ERR"}: ${creditsRes.error || "failed"}`
        );
      }
      if (!keyRes.ok) {
        parts.push(`key ${keyRes.status || "ERR"}: ${keyRes.error || "failed"}`);
      }

      return {
        available: false,
        providers: [],
        error: parts.join(" | ") || "OpenRouter endpoints unavailable",
        source: id,
      };
    }

    const windows = buildWindows(credits, key);

    const plan =
      key?.isFreeTier === true
        ? "free-tier"
        : key?.isManagementKey === true
          ? "management-key"
          : null;

    const warnings = [];
    if (!creditsRes.ok) {
      warnings.push(
        `credits unavailable (${creditsRes.status || "ERR"}: ${creditsRes.error || "failed"})`
      );
    }

    return {
      available: true,
      providers: [
        {
          provider: "openrouter",
          displayName: "OpenRouter",
          plan,
          windows,
          error: null,
          openrouter: {
            credits,
            key,
            warnings,
          },
        },
      ],
      error: null,
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
