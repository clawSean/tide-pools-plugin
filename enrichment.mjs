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
import os from "node:os";

const AGENTS_DIR = path.join(os.homedir(), ".openclaw", "agents");

// Only look at files modified in the last N hours for performance
const DEFAULT_LOOKBACK_HOURS = 24;

// Max bytes to read per file (tail read). Usage entries are spread throughout
// but we get most value from recent messages. 256KB per file keeps things fast.
const MAX_BYTES_PER_FILE = 256 * 1024;

// ─── Session Index ───────────────────────────────────────────────────────────

/**
 * Build a reverse lookup: sessionId UUID → { label, model, agent, kind }
 * by reading sessions.json from all agent directories.
 */
function buildSessionIndex() {
  const index = new Map(); // sessionId → metadata

  try {
    if (!fs.existsSync(AGENTS_DIR)) return index;

    const agents = fs.readdirSync(AGENTS_DIR);
    for (const agent of agents) {
      try {
        const sjPath = path.join(AGENTS_DIR, agent, "sessions", "sessions.json");
        if (!fs.existsSync(sjPath)) continue;

        const raw = fs.readFileSync(sjPath, "utf8");
        const data = JSON.parse(raw);

        for (const [key, meta] of Object.entries(data)) {
          if (!meta || typeof meta !== "object") continue;
          const sid = meta.sessionId;
          if (!sid) continue;

          index.set(sid, {
            key,
            agent,
            label:
              meta.label ||
              meta.displayName ||
              meta.subject ||
              humanizeSessionKey(key),
            model: meta.model || null,
            chatType: meta.chatType || null,
            channel: meta.channel || null,
          });
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Return whatever we got
  }

  return index;
}

/**
 * Turn a raw session key into something readable.
 * "agent:mainelobster:telegram:direct:6566057320" → "DM (telegram)"
 * "agent:main:cron:abc123" → "Cron job"
 */
function humanizeSessionKey(key) {
  if (!key) return "unknown";

  if (key.includes(":cron:")) return "Cron job";
  if (key.includes(":direct:")) {
    const channel = key.match(/:(\w+):direct:/)?.[1] || "dm";
    return `DM (${channel})`;
  }
  if (key.includes(":group:")) {
    const channel = key.match(/:(\w+):group:/)?.[1] || "group";
    return `Group (${channel})`;
  }
  if (key.endsWith(":main")) return "Main session";

  return key.split(":").slice(-2).join(":");
}

// ─── Session Scanning ────────────────────────────────────────────────────────

/**
 * Attempt to collect enrichment data from session JSONLs.
 */
export function collectEnrichment(opts = {}) {
  try {
    const lookbackHours = opts.lookbackHours || DEFAULT_LOOKBACK_HOURS;

    // Build session index for label/model resolution
    const sessionIndex = buildSessionIndex();

    // Find all agent session directories
    const sessionDirs = [];
    try {
      const agents = fs.readdirSync(AGENTS_DIR);
      for (const agent of agents) {
        const dir = path.join(AGENTS_DIR, agent, "sessions");
        if (fs.existsSync(dir)) {
          sessionDirs.push({ agent, dir });
        }
      }
    } catch {
      return { available: false, error: "Could not list agent directories" };
    }

    if (!sessionDirs.length) {
      return { available: false, error: "No session directories found" };
    }

    const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
    const allFiles = [];

    for (const { agent, dir } of sessionDirs) {
      try {
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset."))
          .map((f) => {
            const fp = path.join(dir, f);
            try {
              const stat = fs.statSync(fp);
              return { name: f, path: fp, mtimeMs: stat.mtimeMs, agent };
            } catch {
              return null;
            }
          })
          .filter((f) => f && f.mtimeMs >= cutoff);

        allFiles.push(...files);
      } catch {
        continue;
      }
    }

    if (!allFiles.length) {
      return { available: true, sessions: [], totals: emptyTotals(), byModel: {} };
    }

    // Sort by most recently modified, cap at 20
    allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const scanned = allFiles.slice(0, 20);

    const sessions = [];
    const totals = emptyTotals();
    const byModel = {}; // model → { tokens, cost, sessions }

    for (const file of scanned) {
      try {
        const session = scanSession(file, sessionIndex);
        if (session && session.totalTokens > 0) {
          sessions.push(session);
          totals.input += session.input;
          totals.output += session.output;
          totals.cacheRead += session.cacheRead;
          totals.cacheWrite += session.cacheWrite;
          totals.totalTokens += session.totalTokens;
          totals.costTotal += session.costTotal;
          totals.messageCount += session.messageCount;

          // Aggregate by model
          const model = session.model || "unknown";
          if (!byModel[model]) {
            byModel[model] = { tokens: 0, cost: 0, sessions: 0 };
          }
          byModel[model].tokens += session.totalTokens;
          byModel[model].cost += session.costTotal;
          byModel[model].sessions += 1;
        }
      } catch {
        continue;
      }
    }

    // Sort by totalTokens descending
    sessions.sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      available: true,
      sessions,
      totals: { ...totals, costTotal: Number(totals.costTotal.toFixed(6)) },
      byModel,
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
function scanSession(file, sessionIndex) {
  const sessionId = file.name.replace(".jsonl", "");

  // Resolve metadata from sessions.json index
  const meta = sessionIndex.get(sessionId) || {};

  let raw;
  try {
    const stat = fs.statSync(file.path);
    if (stat.size > MAX_BYTES_PER_FILE) {
      const fd = fs.openSync(file.path, "r");
      const buf = Buffer.alloc(MAX_BYTES_PER_FILE);
      fs.readSync(fd, buf, 0, MAX_BYTES_PER_FILE, stat.size - MAX_BYTES_PER_FILE);
      fs.closeSync(fd);
      raw = buf.toString("utf8");
      const firstNewline = raw.indexOf("\n");
      if (firstNewline > 0) raw = raw.slice(firstNewline + 1);
    } else {
      raw = fs.readFileSync(file.path, "utf8");
    }
  } catch {
    return null;
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);

  let model = meta.model || null;
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

      // Pick up model from model-snapshot custom entries (most recent wins)
      if (
        entry.type === "custom" &&
        entry.customType === "model-snapshot" &&
        entry.data?.modelId
      ) {
        model = entry.data.modelId;
      }

      // Extract usage from message entries
      if (entry.type === "message") {
        const usage = entry.usage || entry.message?.usage;
        if (usage) {
          input += usage.input || 0;
          output += usage.output || 0;
          cacheRead += usage.cacheRead || 0;
          cacheWrite += usage.cacheWrite || 0;
          totalTokens += usage.totalTokens || 0;
          costTotal += usage.cost?.total || 0;
          messageCount++;
        }
      }
    } catch {
      continue;
    }
  }

  return {
    sessionId,
    label: meta.label || humanizeSessionKey(meta.key),
    agent: meta.agent || file.agent || "unknown",
    model,
    chatType: meta.chatType || null,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    costTotal: Number(costTotal.toFixed(6)),
    messageCount,
  };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format enrichment data into a text block for appending to the report.
 * Returns null if enrichment is unavailable or empty.
 *
 * Default view: By Category + By Model (generic, works for anyone).
 * Detail view (opts.detail=true): adds individual session list.
 */
export function formatEnrichment(enrichment, opts = {}) {
  try {
    if (!enrichment?.available || !enrichment?.sessions?.length) return null;

    const detail = opts.detail === true;
    const maxSessions = opts.maxSessions || 8;
    const totals = enrichment.totals;
    const byModel = enrichment.byModel || {};

    const lines = [];
    const period = enrichment.lookbackHours
      ? `last ${enrichment.lookbackHours}h`
      : "recent";

    // ── By Category ──
    const byCategory = {};
    for (const s of enrichment.sessions) {
      const cat = categorizeSession(s);
      if (!byCategory[cat]) {
        byCategory[cat] = { tokens: 0, cost: 0, sessions: 0 };
      }
      byCategory[cat].tokens += s.totalTokens;
      byCategory[cat].cost += s.costTotal;
      byCategory[cat].sessions += 1;
    }

    const catEntries = Object.entries(byCategory).sort(
      (a, b) => b[1].tokens - a[1].tokens
    );

    lines.push(`\nUsage Breakdown (${period}):`);
    const catColWidth = Math.max(...catEntries.map(([c]) => c.length), 6);
    for (const [cat, data] of catEntries) {
      const tokens = fmtTokens(data.tokens);
      const cost = data.cost > 0 ? ` - $${data.cost.toFixed(2)}` : "";
      const count = `(${data.sessions})`;
      lines.push(`  ${cat.padEnd(catColWidth)}  ${tokens} tok${cost}  ${count}`);
    }

    // ── By Model ──
    const modelEntries = Object.entries(byModel).sort(
      (a, b) => b[1].tokens - a[1].tokens
    );

    if (modelEntries.length > 0) {
      lines.push(`\nBy Model:`);
      for (const [m, data] of modelEntries) {
        const tokens = fmtTokens(data.tokens);
        const cost = data.cost > 0 ? ` - $${data.cost.toFixed(2)}` : "";
        lines.push(`  ${shortModel(m)}: ${tokens} tok${cost}`);
      }
    }

    // ── Detail: individual sessions (opt-in) ──
    if (detail) {
      const sessions = enrichment.sessions.slice(0, maxSessions);
      lines.push(`\nSessions:`);
      for (const s of sessions) {
        const tokens = fmtTokens(s.totalTokens);
        const cost = s.costTotal > 0 ? ` - $${s.costTotal.toFixed(2)}` : "";
        const modelTag = s.model ? ` [${shortModel(s.model)}]` : "";
        const label = s.label || s.sessionId.slice(0, 12);
        lines.push(`  ${label}${modelTag} — ${tokens} tok${cost}`);
      }
      if (enrichment.sessions.length > maxSessions) {
        lines.push(`  ... +${enrichment.sessions.length - maxSessions} more`);
      }
    }

    // ── Totals ──
    const totalTok = fmtTokens(totals.totalTokens);
    const totalCost =
      totals.costTotal > 0 ? ` - $${totals.costTotal.toFixed(2)}` : "";
    lines.push(`\nTotal: ${totalTok} tokens${totalCost}`);

    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Categorize a session into a generic bucket.
 */
function categorizeSession(session) {
  const key = session.label || "";
  const chatType = session.chatType || "";

  // Cron jobs
  if (
    key.toLowerCase().startsWith("cron") ||
    (session.sessionId && session.label && session.label.includes("cron"))
  ) {
    return "Cron";
  }

  // Check the raw session key pattern stored in label
  const rawKey = session._rawKey || key;
  if (rawKey.includes(":cron:")) return "Cron";

  // Groups
  if (chatType === "group" || key.includes(":g-") || key.includes("Group")) {
    return "Groups";
  }

  // DMs
  if (chatType === "direct" || key.includes("DM") || key.includes(":direct:")) {
    return "DMs";
  }

  // Main session
  if (key === "Main session" || key.endsWith(":main")) {
    return "Main";
  }

  return "Other";
}

/**
 * Format token count with K/M suffixes for readability.
 */
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Shorten model names for display.
 */
function shortModel(model) {
  if (!model) return "?";
  // Remove provider prefixes and common suffixes
  return model
    .replace(/^(openai-codex|anthropic|google-antigravity|venice|nvidia|ollama)\//, "")
    .replace(/^moonshotai\//, "")
    .replace(/-instruct$/, "")
    .replace(/-preview$/, "");
}
