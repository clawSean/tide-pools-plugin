/**
 * Adapter: venice-diem
 * Fetches Venice balance/rate-limit data via the existing Diem plugin script.
 * Falls back gracefully if the script doesn't exist or fails.
 */

import { exec } from "node:child_process";
import fs from "node:fs";

const DIEM_SCRIPT = `${process.env.HOME || "/root"}/.openclaw/extensions/diem/diem.py`;
const TIMEOUT_MS = 15_000;

export const id = "venice-diem";
export const provider = "venice";

export function isAvailable() {
  try {
    return fs.existsSync(DIEM_SCRIPT);
  } catch {
    return false;
  }
}

function parseDiemOutput(raw) {
  const lines = String(raw || "").split(/\r?\n/);

  let status = null;
  let diem = null;
  let remReq = null;
  let limReq = null;
  let remTok = null;
  let limTok = null;

  for (const line of lines) {
    const l = line.toLowerCase();

    if (l.includes("http status:")) {
      status = line.split(":").slice(1).join(":").trim();
    }
    if (l.includes("x-venice-balance-diem:")) {
      const v = parseFloat(line.split(":").slice(1).join(":").trim());
      if (!Number.isNaN(v)) diem = Number(v.toFixed(6));
    }
    if (l.includes("x-ratelimit-remaining-requests:")) {
      const v = parseInt(line.split(":").slice(1).join(":").trim(), 10);
      if (!Number.isNaN(v)) remReq = v;
    }
    if (l.includes("x-ratelimit-limit-requests:")) {
      const v = parseInt(line.split(":").slice(1).join(":").trim(), 10);
      if (!Number.isNaN(v)) limReq = v;
    }
    if (l.includes("x-ratelimit-remaining-tokens:")) {
      const v = parseInt(line.split(":").slice(1).join(":").trim(), 10);
      if (!Number.isNaN(v)) remTok = v;
    }
    if (l.includes("x-ratelimit-limit-tokens:")) {
      const v = parseInt(line.split(":").slice(1).join(":").trim(), 10);
      if (!Number.isNaN(v)) limTok = v;
    }
  }

  if (status === "402" && diem == null) diem = 0;

  return { status, diem, remReq, limReq, remTok, limTok };
}

function pctLeft(remaining, limit) {
  if (typeof remaining !== "number" || typeof limit !== "number" || limit <= 0)
    return null;
  return Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
}

export async function probe() {
  try {
    if (!isAvailable()) {
      return {
        available: false,
        providers: [],
        error: "Diem script not found",
        source: id,
      };
    }

    let stdout;
    try {
      stdout = await new Promise((resolve, reject) => {
        exec(`python3 ${DIEM_SCRIPT}`, {
          encoding: "utf8",
          timeout: TIMEOUT_MS,
          shell: "/bin/bash",
        }, (err, out, stderr) => {
          if (err) reject(Object.assign(err, { stderr }));
          else resolve(out || "");
        });
      });
    } catch (err) {
      const reason = (err?.stderr || err?.message || "diem script failed").trim();
      return {
        available: false,
        providers: [],
        error: reason,
        source: id,
      };
    }

    const d = parseDiemOutput(stdout);
    const hasData = d.diem != null || d.remReq != null || d.remTok != null;

    if (!hasData) {
      const st = d.status ? ` (HTTP ${d.status})` : "";
      return {
        available: true,
        providers: [
          {
            provider: "venice",
            displayName: "Venice",
            plan: "Diem",
            windows: [],
            error: `No balance headers returned${st}`,
            diem: null,
            requests: null,
            tokens: null,
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
          provider: "venice",
          displayName: "Venice",
          plan: "Diem",
          windows: [], // Venice doesn't use standard windows
          error: null,
          diem: d.diem,
          requests:
            d.remReq != null && d.limReq != null
              ? {
                  remaining: d.remReq,
                  limit: d.limReq,
                  leftPercent: pctLeft(d.remReq, d.limReq),
                }
              : null,
          tokens:
            d.remTok != null && d.limTok != null
              ? {
                  remaining: d.remTok,
                  limit: d.limTok,
                  leftPercent: pctLeft(d.remTok, d.limTok),
                }
              : null,
        },
      ],
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
