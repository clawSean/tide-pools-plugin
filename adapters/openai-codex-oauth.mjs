/**
 * Adapter: openai-codex-oauth
 * Reads OAuth credentials from ~/.codex/auth.json and hits OpenAI's
 * usage endpoint directly for dashboard-accurate quota data.
 *
 * This is the same approach CodexBar uses — first-party session state.
 * If ~/.codex/auth.json doesn't exist or the token is expired, isAvailable()
 * returns false and the adapter is skipped gracefully.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TIMEOUT_MS = 15_000;

export const id = "openai-codex-oauth";
export const provider = "openai-codex";

/**
 * Try to read an OAuth access token from OpenClaw's auth-profiles.json.
 * Picks the profile with the latest expiry that hasn't expired yet.
 */
function readTokenFromAuthProfiles() {
  try {
    const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const agentsDir = path.join(openclawHome, "agents");
    if (!fs.existsSync(agentsDir)) return null;

    let best = null;
    const now = Date.now();

    for (const agent of fs.readdirSync(agentsDir)) {
      const profilePath = path.join(agentsDir, agent, "agent", "auth-profiles.json");
      try {
        const raw = fs.readFileSync(profilePath, "utf8");
        const data = JSON.parse(raw);
        for (const entry of Object.values(data?.profiles || {})) {
          if (entry?.provider !== "openai-codex" || entry?.type !== "oauth") continue;
          if (!entry?.access || typeof entry.access !== "string") continue;
          const expires = typeof entry.expires === "number" ? entry.expires : 0;
          if (expires > 0 && expires < now) continue;
          if (!best || expires > (best.expires || 0)) {
            best = entry;
          }
        }
      } catch { continue; }
    }

    return best?.access || null;
  } catch {}
  return null;
}

/**
 * Quick check: do we have credentials from either source?
 */
export function isAvailable() {
  try {
    if (fs.existsSync(AUTH_PATH)) return true;
  } catch {}
  return Boolean(readTokenFromAuthProfiles());
}

/**
 * Read the OAuth token from ~/.codex/auth.json, falling back to
 * OpenClaw's auth-profiles.json if the file doesn't exist.
 */
function readToken() {
  try {
    const raw = fs.readFileSync(AUTH_PATH, "utf8");
    const data = JSON.parse(raw);

    const token =
      data.access_token ||
      data.accessToken ||
      data.token ||
      data.auth_token ||
      null;

    if (token && typeof token === "string") return token;
  } catch {}

  return readTokenFromAuthProfiles();
}

/**
 * Fetch JSON from a URL with bearer auth.
 */
function fetchJson(url, token) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Request timed out"));
    }, TIMEOUT_MS);

    const req = https.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "tide-pools/2.0",
          Accept: "application/json",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          clearTimeout(timeout);
          if (res.statusCode !== 200) {
            reject(
              new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`JSON parse failed: ${e.message}`));
          }
        });
        res.on("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
      }
    );

    req.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

/**
 * Convert a window duration in seconds to a short label.
 */
function durationLabel(seconds) {
  if (!seconds || typeof seconds !== "number") return "window";
  const hours = seconds / 3600;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  if (days === 7) return "week";
  return `${days}d`;
}

/**
 * Extract windows from a rate_limit / code_review_rate_limit block
 * (new WHAM format, 2025+).
 */
function parseRateLimitBlock(rl, labelPrefix) {
  const out = [];
  if (!rl) return out;

  for (const key of ["primary_window", "secondary_window"]) {
    const w = rl[key];
    if (!w) continue;

    const usedPercent =
      typeof w.used_percent === "number" ? Math.round(w.used_percent) : null;
    const leftPercent =
      typeof usedPercent === "number" ? Math.max(0, 100 - usedPercent) : null;
    const dur = durationLabel(w.limit_window_seconds);
    const label = labelPrefix ? `${labelPrefix} ${dur}` : dur;

    out.push({
      label,
      used: null,
      limit: null,
      remaining: null,
      usedPercent,
      leftPercent,
      resetAt:
        typeof w.reset_at === "number" ? w.reset_at * 1000 : null,
    });
  }

  return out;
}

/**
 * Parse the usage response from OpenAI's WHAM endpoint.
 * Handles both legacy format (usage/windows/codex_usage) and
 * current format (rate_limit with primary/secondary windows).
 */
function parseUsageResponse(data) {
  const windows = [];

  // --- Current WHAM format: rate_limit with primary/secondary windows ---
  if (data?.rate_limit) {
    windows.push(...parseRateLimitBlock(data.rate_limit, ""));
  }

  if (data?.code_review_rate_limit) {
    windows.push(...parseRateLimitBlock(data.code_review_rate_limit, "review"));
  }

  // --- Legacy format: direct usage object ---
  if (data?.usage) {
    const u = data.usage;
    const used = u.used ?? u.messages_used ?? null;
    const limit = u.limit ?? u.messages_limit ?? null;
    const remaining =
      typeof used === "number" && typeof limit === "number"
        ? Math.max(0, limit - used)
        : null;
    const usedPercent =
      typeof used === "number" && typeof limit === "number" && limit > 0
        ? Math.round((used / limit) * 100)
        : null;

    windows.push({
      label: u.plan || u.label || "usage",
      used,
      limit,
      remaining,
      usedPercent,
      leftPercent:
        typeof usedPercent === "number"
          ? Math.max(0, 100 - usedPercent)
          : null,
      resetAt: u.reset_at || u.resetAt || null,
    });
  }

  // --- Legacy format: array of windows/tiers ---
  if (Array.isArray(data?.windows)) {
    for (const w of data.windows) {
      const used = w.used ?? null;
      const limit = w.limit ?? null;
      const remaining =
        typeof used === "number" && typeof limit === "number"
          ? Math.max(0, limit - used)
          : null;
      const usedPercent =
        typeof used === "number" && typeof limit === "number" && limit > 0
          ? Math.round((used / limit) * 100)
          : null;

      windows.push({
        label: w.label || w.name || "window",
        used,
        limit,
        remaining,
        usedPercent,
        leftPercent:
          typeof usedPercent === "number"
            ? Math.max(0, 100 - usedPercent)
            : null,
        resetAt: w.reset_at || w.resetAt || null,
      });
    }
  }

  // --- Legacy format: codex_usage block ---
  if (data?.codex_usage) {
    const cu = data.codex_usage;
    const used = cu.used ?? null;
    const limit = cu.limit ?? null;
    const remaining =
      typeof used === "number" && typeof limit === "number"
        ? Math.max(0, limit - used)
        : null;
    const usedPercent =
      typeof used === "number" && typeof limit === "number" && limit > 0
        ? Math.round((used / limit) * 100)
        : null;

    windows.push({
      label: "codex",
      used,
      limit,
      remaining,
      usedPercent,
      leftPercent:
        typeof usedPercent === "number"
          ? Math.max(0, 100 - usedPercent)
          : null,
      resetAt: cu.reset_at || cu.resetAt || null,
    });
  }

  return windows;
}

export async function probe() {
  try {
    if (!isAvailable()) {
      return {
        available: false,
        providers: [],
        error: "No Codex OAuth credentials found (~/.codex/auth.json or auth-profiles.json)",
        source: id,
      };
    }

    const token = readToken();
    if (!token) {
      return {
        available: false,
        providers: [],
        error: "OAuth token unreadable or expired in both ~/.codex/auth.json and auth-profiles.json",
        source: id,
      };
    }

    const data = await fetchJson(USAGE_URL, token);
    const windows = parseUsageResponse(data);

    if (!windows.length) {
      return {
        available: true,
        providers: [
          {
            provider: "openai-codex",
            displayName: "OpenAI Codex",
            plan: data?.plan_type || data?.plan || data?.subscription || null,
            windows: [],
            error: "Usage endpoint returned no recognizable windows",
            meta: { rawKeys: Object.keys(data || {}) },
          },
        ],
        error: null,
        source: id,
      };
    }

    return {
      available: true,
      providers: [
        {
          provider: "openai-codex",
          displayName: "OpenAI Codex",
          plan: data?.plan_type || data?.plan || data?.subscription || null,
          windows,
          error: null,
          meta: { rawKeys: Object.keys(data || {}) },
        },
      ],
      error: null,
      source: id,
    };
  } catch (err) {
    return {
      available: false,
      providers: [],
      error: `OAuth probe failed: ${err?.message || String(err)}`,
      source: id,
    };
  }
}
