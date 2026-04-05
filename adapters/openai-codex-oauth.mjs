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
 * Quick check: do we have a credential file?
 */
export function isAvailable() {
  try {
    return fs.existsSync(AUTH_PATH);
  } catch {
    return false;
  }
}

/**
 * Read the OAuth token from ~/.codex/auth.json.
 * The file structure varies — we look for common patterns:
 *   { "access_token": "..." }
 *   { "token": "..." }
 *   { "accessToken": "..." }
 */
function readToken() {
  try {
    const raw = fs.readFileSync(AUTH_PATH, "utf8");
    const data = JSON.parse(raw);

    // Try common key names
    const token =
      data.access_token ||
      data.accessToken ||
      data.token ||
      data.auth_token ||
      null;

    if (!token || typeof token !== "string") return null;
    return token;
  } catch {
    return null;
  }
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
 * Parse the usage response from OpenAI's WHAM endpoint.
 * Response shape varies but commonly includes:
 *   { "usage": { "used": N, "limit": N, "reset_at": "ISO", ... } }
 * or nested under plans/windows. We normalize what we find.
 */
function parseUsageResponse(data) {
  const windows = [];

  // Direct usage object (common for Pro/Plus)
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

  // Array of windows/tiers (Teams/Enterprise)
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

  // Codex-specific: check for codex_usage or similar
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
        error: "~/.codex/auth.json not found",
        source: id,
      };
    }

    const token = readToken();
    if (!token) {
      return {
        available: false,
        providers: [],
        error: "Could not read OAuth token from ~/.codex/auth.json",
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
            plan: data?.plan || data?.subscription || null,
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
          plan: data?.plan || data?.subscription || null,
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
