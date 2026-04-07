/**
 * Adapter: openclaw-status
 * Baseline adapter — reads provider usage windows from `openclaw status --usage --json`.
 * This is the universal fallback: works for any provider OpenClaw tracks.
 */

import { exec } from "node:child_process";

const TIMEOUT_MS = 30_000;

function run(cmd, signal) {
  return new Promise((resolve) => {
    const child = exec(cmd, {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      shell: "/bin/bash",
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          error: err?.message || String(err),
          stdout: stdout || "",
        });
      } else {
        resolve({ ok: true, stdout: stdout || "" });
      }
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        try { child.kill(); } catch {}
      }, { once: true });
    }
  });
}

function firstJsonObject(raw) {
  const i = raw.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(raw.slice(i));
  } catch {
    return null;
  }
}

export const id = "openclaw-status";
export const provider = "*"; // covers all providers

export function isAvailable() {
  // openclaw CLI is always present on an OpenClaw host
  return true;
}

export async function probe(opts = {}) {
  try {
    const result = await run("openclaw status --usage --json 2>/dev/null", opts?.signal);
    if (!result.ok) {
      return {
        available: false,
        providers: [],
        error: `openclaw status failed: ${result.error}`,
        source: id,
      };
    }

    const parsed = firstJsonObject(result.stdout || "");
    if (!parsed) {
      return {
        available: false,
        providers: [],
        error: "Failed to parse openclaw status JSON",
        source: id,
      };
    }

    const rawProviders = parsed?.usage?.providers || [];

    const providers = rawProviders.map((p) => {
      const windows = (p.windows || []).map((w) => ({
        label: w.label || "window",
        usedPercent: w.usedPercent ?? null,
        leftPercent:
          typeof w.usedPercent === "number"
            ? Math.max(0, 100 - Math.round(w.usedPercent))
            : null,
        resetAt: w.resetAt || null,
        limit: w.limit ?? null,
        remaining: w.remaining ?? null,
        used: w.used ?? null,
      }));

      return {
        provider: p.provider || "unknown",
        displayName: p.displayName || p.provider || "Unknown",
        plan: p.plan || null,
        windows,
        error: p.error || null,
      };
    });

    return {
      available: true,
      providers,
      error: null,
      source: id,
    };
  } catch (err) {
    return {
      available: false,
      providers: [],
      error: `Unexpected error: ${err?.message || String(err)}`,
      source: id,
    };
  }
}
