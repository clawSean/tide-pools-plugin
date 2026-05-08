/**
 * Adapter: openai-codex-oauth
 * Reads OAuth credentials from ~/.codex/auth.json and OpenClaw auth-profiles,
 * then hits OpenAI's usage endpoint for dashboard-accurate quota data.
 *
 * Supports multiple OAuth profiles — each valid non-expired token is probed
 * separately and returned as a distinct provider row with its own instanceId.
 *
 * This is the same approach CodexBar uses — first-party session state.
 * If no credentials exist or all tokens are expired, isAvailable() returns false.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const TIMEOUT_MS = 15_000;

export const id = "openai-codex-oauth";
export const provider = "openai-codex";

function getUsageUrl() {
  return process.env.CODEX_WHAM_URL || "https://chatgpt.com/backend-api/wham/usage";
}

/**
 * Read all valid OAuth tokens from ~/.codex/auth.json and all auth-profiles.
 * Returns token descriptors — token values are included internally for probing
 * but never surfaced in public output.
 *
 * @returns {{ token: string, instanceId: string, source: string, agent?: string, profileKey?: string, label?: string, expires?: number }[]}
 */
function readAllTokens() {
  const tokens = [];
  const seenTokens = new Set();
  const now = Date.now();

  // Local ~/.codex/auth.json (always "local" profile, no expiry check)
  try {
    const raw = fs.readFileSync(AUTH_PATH, "utf8");
    const data = JSON.parse(raw);
    const token =
      data.access_token ||
      data.accessToken ||
      data.token ||
      data.auth_token ||
      null;
    if (token && typeof token === "string") {
      seenTokens.add(token);
      tokens.push({ token, instanceId: "openai-codex:local", source: "codex-auth", label: "local" });
    }
  } catch {}

  // Auth-profile OAuth entries (one per non-expired profile, deduplicated by token value)
  try {
    const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const agentsDir = path.join(openclawHome, "agents");
    if (!fs.existsSync(agentsDir)) return tokens;

    for (const agent of fs.readdirSync(agentsDir)) {
      const profilePath = path.join(agentsDir, agent, "agent", "auth-profiles.json");
      try {
        const raw = fs.readFileSync(profilePath, "utf8");
        const data = JSON.parse(raw);
        for (const [profileKey, entry] of Object.entries(data?.profiles || {})) {
          if (entry?.provider !== "openai-codex" || entry?.type !== "oauth") continue;
          if (!entry?.access || typeof entry.access !== "string") continue;
          const expires = typeof entry.expires === "number" ? entry.expires : 0;
          if (expires > 0 && expires < now) continue;
          if (seenTokens.has(entry.access)) continue;
          seenTokens.add(entry.access);
          tokens.push({
            token: entry.access,
            instanceId: `openai-codex:profile:${agent}:${profileKey}`,
            source: "profile",
            agent,
            profileKey,
            label: entry.label || entry.name || null,
            expires,
          });
        }
      } catch {
        continue;
      }
    }
  } catch {}

  return tokens;
}

/**
 * Discover all OpenAI Codex auth profiles (metadata only — no token values).
 * Exported for testing and dry-run inspection.
 */
export function discoverProfiles() {
  return readAllTokens().map(({ token: _t, ...meta }) => meta);
}

/**
 * Quick availability check: do we have any usable credential source?
 */
export function isAvailable() {
  try {
    if (fs.existsSync(AUTH_PATH)) return true;
  } catch {}
  // Quick check: any non-expired auth-profile OAuth entry?
  try {
    const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
    const agentsDir = path.join(openclawHome, "agents");
    if (!fs.existsSync(agentsDir)) return false;
    const now = Date.now();
    for (const agent of fs.readdirSync(agentsDir)) {
      const profilePath = path.join(agentsDir, agent, "agent", "auth-profiles.json");
      try {
        const raw = fs.readFileSync(profilePath, "utf8");
        const data = JSON.parse(raw);
        for (const entry of Object.values(data?.profiles || {})) {
          if (entry?.provider !== "openai-codex" || entry?.type !== "oauth") continue;
          if (!entry?.access) continue;
          const expires = typeof entry.expires === "number" ? entry.expires : 0;
          if (expires > 0 && expires < now) continue;
          return true;
        }
      } catch { continue; }
    }
  } catch {}
  return false;
}

/**
 * Fetch JSON from a URL with bearer auth. Supports both http:// and https://.
 */
function fetchJson(url, token) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    };
    const timeout = setTimeout(() => {
      try { req?.destroy(); } catch {}
      finishReject(new Error("Request timed out"));
    }, TIMEOUT_MS);

    const requester = url.startsWith("https://") ? https : http;
    req = requester.get(
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
          if (res.statusCode !== 200) {
            finishReject(
              new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)
            );
            return;
          }
          try {
            finishResolve(JSON.parse(body));
          } catch (e) {
            finishReject(new Error(`JSON parse failed: ${e.message}`));
          }
        });
        res.on("error", (e) => {
          finishReject(e);
        });
      }
    );

    req.on("error", (e) => {
      finishReject(e);
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

/**
 * Probe a single OAuth token and return a provider entry, or null if it fails.
 */
async function probeOneToken(usageUrl, { token, instanceId, source: tokenSource, agent, profileKey, label }) {
  const data = await fetchJson(usageUrl, token);
  const windows = parseUsageResponse(data);

  let displayName = "OpenAI Codex";
  if (tokenSource === "profile") {
    const nameHint = label || agent || profileKey;
    if (nameHint) displayName = `OpenAI Codex [${nameHint}]`;
  }

  return {
    provider: "openai-codex",
    instanceId,
    displayName,
    plan: data?.plan_type || data?.plan || data?.subscription || null,
    windows,
    error: windows.length ? null : "Usage endpoint returned no recognizable windows",
    meta: {
      rawKeys: Object.keys(data || {}),
      source: tokenSource,
      agent: agent || null,
    },
  };
}

export async function probe() {
  try {
    const allTokens = readAllTokens();

    if (!allTokens.length) {
      return {
        available: false,
        providers: [],
        error: "No Codex OAuth credentials found (~/.codex/auth.json or auth-profiles.json)",
        source: id,
      };
    }

    const usageUrl = getUsageUrl();

    const settled = await Promise.all(
      allTokens.map((t) =>
        probeOneToken(usageUrl, t).catch((err) => ({
          provider: null,
          instanceId: t.instanceId,
          error: `${t.label || t.agent || t.profileKey || t.instanceId}: ${err?.message || String(err)}`,
        }))
      )
    );

    const providers = settled.filter((entry) => entry?.provider);
    const tokenErrors = settled.filter((entry) => !entry?.provider && entry?.error).map((entry) => entry.error);

    if (!providers.length) {
      return {
        available: false,
        providers: [],
        error: tokenErrors.length
          ? `All OAuth probes failed: ${tokenErrors.join(" | ")}`
          : "All OAuth probes failed (tokens may be expired)",
        source: id,
      };
    }

    return {
      available: true,
      providers,
      error: tokenErrors.length ? `${tokenErrors.length} OAuth profile(s) failed` : null,
      warnings: tokenErrors,
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
