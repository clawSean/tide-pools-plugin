/**
 * Adapter: anthropic-cli-usage
 *
 * Reads Claude Code `/usage` output from a tmux session (same source Anthrometer uses).
 *
 * Behavior:
 *  - auto (default): only returns Anthropic data when subscription windows are present.
 *                  If API-mode-only is detected, adapter yields no provider so openclaw-status fallback can win.
 *  - subscription: require subscription windows from `/usage`.
 *  - api: disabled at registry layer (falls back to openclaw-status).
 */

import { execSync, exec } from "node:child_process";

export const id = "anthropic-cli-usage";
export const provider = "anthropic";

const DEFAULT_TIMEOUT_MS = 20_000;

function sh(cmd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      encoding: "utf8",
      timeout: timeoutMs,
      shell: "/bin/bash",
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout || "").trim());
    });
  });
}

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function isAvailable() {
  try {
    execSync("command -v tmux >/dev/null && command -v claude >/dev/null", {
      encoding: "utf8", timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash",
    });
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(text = "") {
  return String(text)
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function utcDateParts(now = new Date()) {
  return {
    y: now.getUTCFullYear(),
    m: now.getUTCMonth(),
    d: now.getUTCDate(),
  };
}

function formatUtcIso(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function parseResetTime(resetText, now = new Date()) {
  if (!resetText) return null;

  const raw = String(resetText).trim();
  const cleaned = raw.replace(/\(UTC\)/gi, "").replace(/\s+/g, " ").trim();

  const monthDayRe = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/i;
  const md = cleaned.match(monthDayRe);
  if (md) {
    const monthNames = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = monthNames[md[1].slice(0, 3).toLowerCase()];
    const day = Number(md[2]);

    let hour = 0;
    let minute = 0;
    if (md[3]) {
      hour = Number(md[3]);
      minute = Number(md[4] || "0");
      const ap = String(md[5] || "").toLowerCase();
      if (ap === "pm" && hour < 12) hour += 12;
      if (ap === "am" && hour === 12) hour = 0;
    }

    const nowParts = utcDateParts(now);
    let dt = new Date(Date.UTC(nowParts.y, month, day, hour, minute, 0, 0));
    if (dt.getTime() <= now.getTime()) {
      dt = new Date(Date.UTC(nowParts.y + 1, month, day, hour, minute, 0, 0));
    }
    return dt;
  }

  const timeOnlyRe = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;
  const t = cleaned.match(timeOnlyRe);
  if (t) {
    let hour = Number(t[1]);
    const minute = Number(t[2] || "0");
    const ap = t[3].toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;

    const { y, m, d } = utcDateParts(now);
    let dt = new Date(Date.UTC(y, m, d, hour, minute, 0, 0));
    if (dt.getTime() <= now.getTime()) {
      dt = new Date(Date.UTC(y, m, d + 1, hour, minute, 0, 0));
    }
    return dt;
  }

  const fallback = new Date(`${cleaned} UTC`);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";

  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

function sectionSlice(lines, startIndex, maxLookahead = 12) {
  return lines.slice(startIndex, Math.min(lines.length, startIndex + maxLookahead));
}

function findHeadingIndex(lines, regex) {
  return lines.findIndex((line) => regex.test(line.trim()));
}

function parseWindowSection(lines, headingRegex, now = new Date()) {
  const idx = findHeadingIndex(lines, headingRegex);
  if (idx < 0) return null;

  const chunk = sectionSlice(lines, idx, 14).join("\n");
  const pct = chunk.match(/(\d+)\s*%\s*used/i)?.[1] ?? null;
  const resetText = chunk.match(/Resets\s+([^\n]+)/i)?.[1]?.trim() ?? null;
  const resetAt = parseResetTime(resetText, now);
  const resetInMs = resetAt ? resetAt.getTime() - now.getTime() : null;

  return {
    pctUsed: pct ? Number(pct) : null,
    pctRemaining: pct ? Math.max(0, 100 - Number(pct)) : null,
    resetText,
    resetAtIso: formatUtcIso(resetAt),
    resetIn: formatDuration(resetInMs),
  };
}

function parseExtraSection(lines, now = new Date()) {
  const idx = findHeadingIndex(lines, /^extra usage$/i);
  if (idx < 0) {
    return {
      status: /out of extra usage/i.test(lines.join("\n")) ? "exhausted" : "unknown",
      pctUsed: null,
      pctRemaining: null,
      spentUsd: null,
      limitUsd: null,
      availableUsd: null,
      overUsd: null,
      resetText: null,
      resetAtIso: null,
      resetIn: null,
    };
  }

  const chunk = sectionSlice(lines, idx, 16).join("\n");
  const pct = chunk.match(/(\d+)\s*%\s*used/i)?.[1] ?? null;

  let status = "unknown";
  if (/not enabled/i.test(chunk)) status = "not enabled";
  else if (/enabled/i.test(chunk)) status = "enabled";

  const money = chunk.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*spent/i);
  const spentUsd = toNumber(money?.[1] ?? null);
  const limitUsd = toNumber(money?.[2] ?? null);
  const availableUsd = spentUsd != null && limitUsd != null ? Math.max(0, limitUsd - spentUsd) : null;
  const overUsd = spentUsd != null && limitUsd != null ? Math.max(0, spentUsd - limitUsd) : null;

  const resetText = chunk.match(/Resets\s+([^\n]+)/i)?.[1]?.trim() ?? null;
  const resetAt = parseResetTime(resetText, now);
  const resetInMs = resetAt ? resetAt.getTime() - now.getTime() : null;

  if (status === "unknown" && (pct != null || (spentUsd != null && limitUsd != null))) {
    status = "enabled";
  }
  if (/out of extra usage/i.test(chunk)) status = "exhausted";

  return {
    status,
    pctUsed: pct ? Number(pct) : null,
    pctRemaining: pct ? Math.max(0, 100 - Number(pct)) : null,
    spentUsd,
    limitUsd,
    availableUsd,
    overUsd,
    resetText,
    resetAtIso: formatUtcIso(resetAt),
    resetIn: formatDuration(resetInMs),
  };
}

function parseApiBudget(clean, now = new Date()) {
  const lines = clean.split("\n").map((l) => l.trimEnd());
  const monthSection = parseWindowSection(lines, /^current month(?:\s*\(.*\))?$/i, now);

  if (!monthSection && !/api\s+usage/i.test(clean)) return null;

  const moneyMatch = clean.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*spent/i);
  const spentUsd = toNumber(moneyMatch?.[1] ?? null);
  const limitUsd = toNumber(moneyMatch?.[2] ?? null);
  const remainingUsd = spentUsd != null && limitUsd != null ? Math.max(0, limitUsd - spentUsd) : null;

  if (!monthSection && spentUsd == null && limitUsd == null) return null;

  return {
    label: "api-month",
    pctUsed: monthSection?.pctUsed ?? null,
    pctRemaining: monthSection?.pctRemaining ?? null,
    resetText: monthSection?.resetText ?? null,
    resetAtIso: monthSection?.resetAtIso ?? null,
    resetIn: monthSection?.resetIn ?? null,
    spentUsd,
    limitUsd,
    remainingUsd,
  };
}

function parseUsage(raw = "", now = new Date()) {
  const clean = stripAnsi(raw);
  const lines = clean.split("\n").map((l) => l.trimEnd());

  const fiveHour = parseWindowSection(lines, /^current session$/i, now)
    || parseWindowSection(lines, /^current 5[ -]?hour(?: window)?$/i, now)
    || parseWindowSection(lines, /^current 5h(?: window)?$/i, now);

  const week = parseWindowSection(lines, /^current week(?:\s*\(all models\))?$/i, now);
  const extra = parseExtraSection(lines, now);
  const api = parseApiBudget(clean, now);

  const profileLine = lines.find((l) => /Claude\s+(Pro|Max|Team|Enterprise|API)/i.test(l)) || null;
  const mode = /Claude\s+API/i.test(profileLine || "")
    ? "api"
    : (fiveHour || week || /Claude\s+(Pro|Max|Team|Enterprise)/i.test(profileLine || ""))
      ? "subscription"
      : api
        ? "api"
        : "unknown";

  return {
    mode,
    fiveHour,
    week,
    extra,
    api,
    profileLine,
    clean,
  };
}

function looksLikeUsageOutput(raw) {
  const t = String(raw || "");
  return /(Current\s+session|Current\s+5[ -]?hour|Current\s+week|Extra\s+usage|Current\s+month|API\s+budget|\b\d+%\s*used\b)/i.test(t);
}

// ─── Session lifecycle helpers ───────────────────────────────────────────────

async function capturePaneText(sessionName) {
  try {
    return await sh(`tmux capture-pane -t ${q(sessionName)} -p 2>/dev/null`, 5000);
  } catch {
    return "";
  }
}

async function sessionExists(sessionName) {
  try {
    await sh(`tmux has-session -t ${q(sessionName)} 2>/dev/null`, 5000);
    return true;
  } catch {
    return false;
  }
}

async function killSession(sessionName) {
  try { await sh(`tmux kill-session -t ${q(sessionName)} 2>/dev/null`, 5000); } catch {}
}

function paneHasTrustPrompt(pane) {
  return /trust this folder/i.test(pane) || /Yes, I trust/i.test(pane);
}

function paneHasReplPrompt(pane) {
  const clean = stripAnsi(pane);
  return clean.split("\n").some((line) => /^\s*❯\s*$/.test(line));
}

/**
 * Ensure the tmux session exists and Claude is at its REPL prompt.
 * Handles: session creation, trust-dialog acceptance, boot wait.
 * Returns { ready, isNew, error? }.
 */
async function ensureSessionReady(sessionName, claudeCommand, maxWaitMs = 18000) {
  let isNew = false;

  if (!(await sessionExists(sessionName))) {
    isNew = true;
    try {
      await sh(`tmux new-session -d -s ${q(sessionName)} -x 120 -y 40 ${q(claudeCommand)}`, 10000);
    } catch (err) {
      return { ready: false, isNew, error: `tmux new-session failed: ${err?.message || err}` };
    }
  }

  // Dismiss any stale dialog (e.g. previous /usage output still on screen)
  try { await sh(`tmux send-keys -t ${q(sessionName)} Escape 2>/dev/null`, 3000); } catch {}

  const start = Date.now();
  const pollMs = 1500;
  let lastPane = "";

  while (Date.now() - start < maxWaitMs) {
    lastPane = await capturePaneText(sessionName);

    if (paneHasTrustPrompt(lastPane)) {
      try { await sh(`tmux send-keys -t ${q(sessionName)} Enter`, 3000); } catch {}
      try { await sh("sleep 3", 5000); } catch {}
      continue;
    }

    if (paneHasReplPrompt(lastPane)) {
      return { ready: true, isNew };
    }

    try { await sh(`sleep ${pollMs / 1000}`, pollMs + 2000); } catch {}
  }

  return {
    ready: false,
    isNew,
    error: `Claude REPL not ready after ${Math.round(maxWaitMs / 1000)}s (last pane: ${stripAnsi(lastPane).slice(-120)})`,
  };
}

/**
 * Reset the REPL input line: dismiss any open dialog, cancel pending input,
 * clear the line buffer, then clear the screen.
 */
async function resetReplInput(sessionName) {
  const cmds = [
    `tmux send-keys -t ${q(sessionName)} Escape`,
    "sleep 0.3",
    `tmux send-keys -t ${q(sessionName)} C-c`,
    "sleep 0.3",
    `tmux send-keys -t ${q(sessionName)} C-u`,
    `tmux send-keys -t ${q(sessionName)} C-l`,
    "sleep 0.5",
  ].join("; ");
  try { await sh(cmds, 8000); } catch {}
}

/**
 * Send /usage to a ready session and capture the output.
 */
async function sendUsageAndCapture(sessionName, timeoutMs) {
  const attempts = [
    [
      `tmux send-keys -t ${q(sessionName)} '/usage'`,
      "sleep 0.6",
      `tmux send-keys -t ${q(sessionName)} Enter`,
      "sleep 0.8",
      `tmux send-keys -t ${q(sessionName)} Enter`,
      "sleep 2.5",
      `tmux capture-pane -t ${q(sessionName)} -p | tail -260`,
    ].join("; "),
    [
      `tmux send-keys -t ${q(sessionName)} '/usage' Enter`,
      "sleep 1.0",
      `tmux send-keys -t ${q(sessionName)} Enter`,
      "sleep 2.5",
      `tmux capture-pane -t ${q(sessionName)} -p | tail -260`,
    ].join("; "),
  ];

  let last = "";
  for (const step of attempts) {
    await resetReplInput(sessionName);
    try {
      const raw = await sh(step, timeoutMs);
      last = raw;
      if (looksLikeUsageOutput(raw)) return { ok: true, raw };
    } catch (err) {
      last = err?.message || String(err);
    }
  }
  return { ok: false, raw: last };
}

/**
 * Full lifecycle: ensure session is ready → send /usage → capture output.
 * On failure, kills the session and retries once from scratch.
 */
async function fetchUsageRaw(sessionName, timeoutMs, claudeCommand) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ready = await ensureSessionReady(sessionName, claudeCommand);
    if (!ready.ready) {
      if (attempt === 0) {
        await killSession(sessionName);
        continue;
      }
      return { raw: "", error: ready.error || "Claude REPL never became ready" };
    }

    const result = await sendUsageAndCapture(sessionName, timeoutMs);
    if (result.ok) return { raw: result.raw, error: null };

    if (attempt === 0) {
      await killSession(sessionName);
    } else {
      return {
        raw: result.raw,
        error: "Could not capture /usage output after retry",
      };
    }
  }

  return { raw: "", error: "fetchUsageRaw exhausted retries" };
}

function providerFromParsed(parsed) {
  const windows = [];
  if (parsed?.fiveHour?.pctUsed != null) {
    windows.push({
      label: "5h",
      usedPercent: parsed.fiveHour.pctUsed,
      leftPercent: parsed.fiveHour.pctRemaining,
      resetAt: parsed.fiveHour.resetAtIso,
      resetText: parsed.fiveHour.resetText,
      resetIn: parsed.fiveHour.resetIn,
    });
  }
  if (parsed?.week?.pctUsed != null) {
    windows.push({
      label: "week",
      usedPercent: parsed.week.pctUsed,
      leftPercent: parsed.week.pctRemaining,
      resetAt: parsed.week.resetAtIso,
      resetText: parsed.week.resetText,
      resetIn: parsed.week.resetIn,
    });
  }

  const extra = parsed?.extra || null;
  if (extra && (extra.pctUsed != null || (extra.spentUsd != null && extra.limitUsd != null))) {
    const pctFromMoney = extra.spentUsd != null && extra.limitUsd != null && extra.limitUsd > 0
      ? (extra.spentUsd / extra.limitUsd) * 100
      : null;
    windows.push({
      label: "extra",
      usedPercent: extra.pctUsed != null ? extra.pctUsed : (pctFromMoney != null ? Math.round(pctFromMoney) : null),
      leftPercent: extra.pctRemaining,
      resetAt: extra.resetAtIso,
      resetText: extra.resetText,
      resetIn: extra.resetIn,
      spentUsd: extra.spentUsd,
      limitUsd: extra.limitUsd,
      availableUsd: extra.availableUsd,
      overUsd: extra.overUsd,
      status: extra.status,
    });
  }

  if (parsed?.mode === "api" && parsed?.api) {
    windows.push({
      label: parsed.api.label || "api-month",
      usedPercent: parsed.api.pctUsed,
      leftPercent: parsed.api.pctRemaining,
      resetAt: parsed.api.resetAtIso,
      resetText: parsed.api.resetText,
      resetIn: parsed.api.resetIn,
      spentUsd: parsed.api.spentUsd,
      limitUsd: parsed.api.limitUsd,
      remainingUsd: parsed.api.remainingUsd,
    });
  }

  return {
    provider: "anthropic",
    displayName: "Anthropic Claude",
    plan: parsed?.mode || null,
    windows,
    error: null,
    anthropic: {
      mode: parsed?.mode || "unknown",
      fiveHour: parsed?.fiveHour || null,
      week: parsed?.week || null,
      extra: parsed?.extra || null,
      api: parsed?.api || null,
    },
  };
}

export async function probe(opts = {}) {
  const sourceMode = String(opts?.anthropicSource || process.env.TIDE_POOLS_ANTHROPIC_SOURCE || "auto").toLowerCase();
  if (sourceMode === "api") {
    return {
      available: false,
      providers: [],
      error: "anthropicSource=api (use fallback openclaw-status)",
      source: id,
    };
  }

  try {
    const tmuxSession = process.env.TIDE_POOLS_ANTHROPIC_TMUX_SESSION || "claude_usage_cmd";
    const timeoutMs = Number(process.env.TIDE_POOLS_ANTHROPIC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    const claudeCommand = process.env.TIDE_POOLS_ANTHROPIC_CLAUDE_CMD || "claude";

    const result = await fetchUsageRaw(tmuxSession, timeoutMs, claudeCommand);

    if (result.error) {
      return {
        available: false,
        providers: [],
        error: `Claude CLI session error: ${result.error}`,
        source: id,
      };
    }

    const parsed = parseUsage(result.raw, new Date());

    if (sourceMode === "subscription" && parsed.mode !== "subscription") {
      return {
        available: false,
        providers: [],
        error: `subscription mode requested but detected ${parsed.mode || "unknown"}`,
        source: id,
      };
    }

    if (sourceMode === "auto" && parsed.mode !== "subscription") {
      return {
        available: false,
        providers: [],
        error: `auto mode defers non-subscription anthropic to fallback (${parsed.mode || "unknown"})`,
        source: id,
      };
    }

    const p = providerFromParsed(parsed);
    if (!p.windows?.length) {
      return {
        available: false,
        providers: [],
        error: "No recognizable usage windows from /usage output (Claude CLI may have changed its format)",
        source: id,
      };
    }

    return {
      available: true,
      providers: [p],
      error: null,
      source: id,
    };
  } catch (err) {
    return {
      available: false,
      providers: [],
      error: `Anthropic CLI usage probe failed: ${err?.message || String(err)}`,
      source: id,
    };
  }
}
