/**
 * Enrichment Layer — JSONL session mining for usage breakdown.
 *
 * 100% OPTIONAL. Every export is wrapped in try/catch.
 * If anything here fails, the caller gets { available: false } and
 * the main report renders perfectly without this section.
 *
 * This answers "where did my usage go?" — not "how much is left?"
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_SESSIONS_DIR = path.join(
  process.env.HOME || "/root",
  ".openclaw",
  "agents",
  "mainelobster",
  "sessions"
);

// Only look at files modified in the last N hours for performance
const DEFAULT_LOOKBACK_HOURS = 24;

// Max bytes to read per file (tail read). Usage entries are spread throughout
// but we get most value from recent messages. 256KB per file keeps things fast.
const MAX_BYTES_PER_FILE = 256 * 1024;

/**
 * Attempt to collect enrichment data from session JSONLs.
 *
 * @param {object} opts
 * @param {string} opts.sessionsDir - path to sessions directory
 * @param {number} opts.lookbackHours - how far back to scan
 * @returns {{ available: boolean, sessions?: object[], totals?: object, error?: string }}
 */
export function collectEnrichment(opts = {}) {
  try {
    const sessionsDir = opts.sessionsDir || DEFAULT_SESSIONS_DIR;
    const lookbackHours = opts.lookbackHours || DEFAULT_LOOKBACK_HOURS;

    if (!fs.existsSync(sessionsDir)) {
      return { available: false, error: "Sessions directory not found" };
    }

    const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
    let files;
    try {
      files = fs
        .readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset."))
        .map((f) => {
          const fp = path.join(sessionsDir, f);
          try {
            const stat = fs.statSync(fp);
            return { name: f, path: fp, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((f) => f && f.mtimeMs >= cutoff)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return { available: false, error: "Could not list session files" };
    }

    if (!files.length) {
      return { available: true, sessions: [], totals: emptyTotals() };
    }

    // Cap file count to keep scan time under a few seconds
    const MAX_FILES = 20;
    const scanned = files.slice(0, MAX_FILES);

    const sessions = [];
    const totals = emptyTotals();

    for (const file of scanned) {
      try {
        const session = scanSession(file);
        if (session && session.totalTokens > 0) {
          sessions.push(session);
          totals.input += session.input;
          totals.output += session.output;
          totals.cacheRead += session.cacheRead;
          totals.cacheWrite += session.cacheWrite;
          totals.totalTokens += session.totalTokens;
          totals.costTotal += session.costTotal;
          totals.messageCount += session.messageCount;
        }
      } catch {
        // Skip broken files silently
        continue;
      }
    }

    // Sort by totalTokens descending
    sessions.sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      available: true,
      sessions,
      totals,
      scannedFiles: scanned.length,
      lookbackHours,
    };
  } catch (err) {
    return {
      available: false,
      error: `Enrichment failed: ${err?.message || String(err)}`,
    };
  }
}

function emptyTotals() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costTotal: 0,
    messageCount: 0,
  };
}

/**
 * Scan a single session JSONL file for usage data.
 * Reads only the last MAX_BYTES_PER_FILE bytes for large files to stay fast.
 */
function scanSession(file) {
  let raw;
  try {
    const stat = fs.statSync(file.path);
    if (stat.size > MAX_BYTES_PER_FILE) {
      // Read only the tail — we'll miss some early entries but stay fast
      const fd = fs.openSync(file.path, "r");
      const buf = Buffer.alloc(MAX_BYTES_PER_FILE);
      fs.readSync(fd, buf, 0, MAX_BYTES_PER_FILE, stat.size - MAX_BYTES_PER_FILE);
      fs.closeSync(fd);
      raw = buf.toString("utf8");
      // Drop the first partial line (we likely cut mid-line)
      const firstNewline = raw.indexOf("\n");
      if (firstNewline > 0) raw = raw.slice(firstNewline + 1);
    } else {
      raw = fs.readFileSync(file.path, "utf8");
    }
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);

  let sessionKey = null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let costTotal = 0;
  let messageCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Extract session key from session header
      if (entry.type === "session" && entry.id) {
        // session id is the UUID, not the key — but it's what we have
        sessionKey = entry.id;
      }

      // Extract usage from message entries
      if (entry.type === "message") {
        const usage = entry.usage || entry.message?.usage;
        if (usage) {
          const inp = usage.input || 0;
          const out = usage.output || 0;
          const cr = usage.cacheRead || 0;
          const cw = usage.cacheWrite || 0;
          const tt = usage.totalTokens || 0;
          const ct = usage.cost?.total || 0;

          input += inp;
          output += out;
          cacheRead += cr;
          cacheWrite += cw;
          totalTokens += tt;
          costTotal += ct;
          messageCount++;
        }
      }
    } catch {
      // Skip unparseable lines
      continue;
    }
  }

  return {
    sessionId: file.name.replace(".jsonl", ""),
    sessionKey: sessionKey || file.name.replace(".jsonl", ""),
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    costTotal: Number(costTotal.toFixed(6)),
    messageCount,
  };
}

/**
 * Format enrichment data into a text block for appending to the report.
 * Returns null if enrichment is unavailable or empty.
 *
 * @param {object} enrichment - result from collectEnrichment()
 * @param {object} opts
 * @param {number} opts.maxSessions - max sessions to show (default: 8)
 * @returns {string|null}
 */
export function formatEnrichment(enrichment, opts = {}) {
  try {
    if (!enrichment?.available || !enrichment?.sessions?.length) return null;

    const maxSessions = opts.maxSessions || 8;
    const totals = enrichment.totals;
    const sessions = enrichment.sessions.slice(0, maxSessions);

    const lines = [];
    const period = enrichment.lookbackHours
      ? `last ${enrichment.lookbackHours}h`
      : "recent";

    lines.push(`\nSession Breakdown (${period}):`);

    for (const s of sessions) {
      const tokens = Number(s.totalTokens).toLocaleString();
      const cost = s.costTotal > 0 ? ` ($${s.costTotal.toFixed(2)})` : "";
      const label = truncateSessionId(s.sessionId);
      lines.push(`  ${label} — ${tokens} tokens${cost}`);
    }

    if (enrichment.sessions.length > maxSessions) {
      const remaining = enrichment.sessions.length - maxSessions;
      lines.push(`  ... and ${remaining} more sessions`);
    }

    // Totals line
    const totalTok = Number(totals.totalTokens).toLocaleString();
    const totalCost =
      totals.costTotal > 0 ? ` ($${totals.costTotal.toFixed(2)})` : "";
    lines.push(`  Total: ${totalTok} tokens${totalCost}`);

    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Shorten a UUID session id to something readable.
 */
function truncateSessionId(id) {
  if (!id || id.length <= 16) return id || "unknown";
  return id.slice(0, 8) + "…" + id.slice(-4);
}
