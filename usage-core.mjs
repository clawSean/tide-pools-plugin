import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CACHE_TTL_MS = 45_000;

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function firstJsonObject(raw) {
  const i = raw.indexOf("{");
  if (i < 0) return null;
  return safeJsonParse(raw.slice(i));
}

function run(cmd, timeoutMs = 20000) {
  try {
    const stdout = execSync(cmd, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      shell: "/bin/bash",
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      stdout: err?.stdout ? String(err.stdout) : "",
      stderr: err?.stderr ? String(err.stderr) : "",
    };
  }
}

function countdown(resetAtMs) {
  if (!resetAtMs) return "reset unknown";
  const delta = Math.max(0, resetAtMs - Date.now());
  const totalMins = Math.floor(delta / 60000);
  const d = Math.floor(totalMins / 1440);
  const h = Math.floor((totalMins % 1440) / 60);
  const m = totalMins % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return `in ${parts.join(" ")}`;
}

function leftPercent(usedPercent) {
  if (typeof usedPercent !== "number" || Number.isNaN(usedPercent)) return null;
  return Math.max(0, 100 - Math.round(usedPercent));
}

function pctLeft(remaining, limit) {
  if (typeof remaining !== "number" || typeof limit !== "number" || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
}

function parseUsageStatus() {
  const probe = run("openclaw status --usage --json 2>/dev/null");
  if (!probe.ok) return { providers: [], error: `status call failed: ${probe.error}` };

  const parsed = firstJsonObject(probe.stdout || "");
  if (!parsed) return { providers: [], error: "status JSON parse failed" };

  return {
    providers: parsed?.usage?.providers || [],
    raw: parsed,
    error: null,
  };
}

function parseVeniceFromDiemOutput(raw) {
  const lines = String(raw || "").split(/\r?\n/);

  let status;
  let diem;
  let remReq;
  let limReq;
  let remTok;
  let limTok;

  for (const line of lines) {
    const l = line.toLowerCase();
    if (l.includes("http status:")) status = line.split(":").slice(1).join(":").trim();

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

  return {
    available: diem != null || remReq != null || remTok != null,
    status: status || null,
    diem,
    requests:
      remReq != null && limReq != null
        ? {
            remaining: remReq,
            limit: limReq,
            leftPercent: pctLeft(remReq, limReq),
          }
        : null,
    tokens:
      remTok != null && limTok != null
        ? {
            remaining: remTok,
            limit: limTok,
            leftPercent: pctLeft(remTok, limTok),
          }
        : null,
  };
}

function getVeniceUsage() {
  const probe = run("python3 ~/.openclaw/extensions/diem/diem.py", 15000);
  if (!probe.ok) {
    const reason = (probe.stderr || probe.error || "venice check failed").trim();
    return {
      source: "diem-plugin",
      available: false,
      optional: true,
      error: reason,
      raw: probe,
      data: null,
    };
  }

  const data = parseVeniceFromDiemOutput(probe.stdout);
  return {
    source: "diem-plugin",
    available: data.available,
    optional: true,
    error: null,
    data,
    raw: probe.stdout,
  };
}

function providerLooksLikeVenice(p) {
  const id = String(p?.provider || "").toLowerCase();
  const dn = String(p?.displayName || "").toLowerCase();
  return id.includes("venice") || dn.includes("venice");
}

function resolveCachePath(customPath) {
  if (customPath) return customPath;
  if (process.env.TIDE_POOL_CACHE_PATH) return process.env.TIDE_POOL_CACHE_PATH;
  if (process.env.LOBSTER_USAGE_CACHE_PATH) return process.env.LOBSTER_USAGE_CACHE_PATH;
  return path.join(os.tmpdir(), "openclaw-tide-pools-cache.json");
}

function readCache(cachePath, ttlMs) {
  if (!ttlMs || ttlMs <= 0) return null;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed.cachedAtMs !== "number" || !parsed.snapshot) return null;
    if (Date.now() - parsed.cachedAtMs > ttlMs) return null;
    return parsed.snapshot;
  } catch {
    return null;
  }
}

function writeCache(cachePath, snapshot) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const payload = {
      cachedAtMs: Date.now(),
      snapshot,
    };
    fs.writeFileSync(cachePath, JSON.stringify(payload));
  } catch {
    // best effort cache only
  }
}

export function collectUsageSnapshot(opts = {}) {
  const includeVenice = opts.includeVenice !== false;
  const cacheTtlMs = Number.isFinite(opts.cacheTtlMs) ? Number(opts.cacheTtlMs) : DEFAULT_CACHE_TTL_MS;
  const cachePath = resolveCachePath(opts.cachePath);
  const bypassCache = opts.bypassCache === true;

  if (!bypassCache) {
    const cached = readCache(cachePath, cacheTtlMs);
    if (cached) {
      return {
        ...cached,
        cache: { hit: true, ttlMs: cacheTtlMs, path: cachePath },
      };
    }
  }

  const status = parseUsageStatus();
  const providers = Array.isArray(status.providers) ? status.providers : [];
  const hasVeniceInStatus = providers.some(providerLooksLikeVenice);
  const venice = includeVenice && !hasVeniceInStatus ? getVeniceUsage() : null;

  const snapshot = {
    generatedAt: new Date().toISOString(),
    statusError: status.error || null,
    providers,
    hasVeniceInStatus,
    venice,
  };

  if (!bypassCache && cacheTtlMs > 0) writeCache(cachePath, snapshot);

  return {
    ...snapshot,
    cache: { hit: false, ttlMs: cacheTtlMs, path: cachePath },
  };
}

function formatProviderLine(p) {
  const name = p.displayName || p.provider || "Unknown provider";
  const plan = p.plan ? ` [${p.plan}]` : "";

  if (p.error) return `• ${name}${plan}: unavailable — ${p.error}`;

  const windows = Array.isArray(p.windows) ? p.windows : [];
  if (!windows.length) return `• ${name}${plan}: no quota windows returned`;

  const chunks = windows.map((w) => {
    const label = w.label || "window";
    const left = leftPercent(w.usedPercent);
    const leftTxt = left == null ? "left unknown" : `${left}% left`;
    return `${label}: ${leftTxt} (${countdown(w.resetAt)})`;
  });

  return `• ${name}${plan}: ${chunks.join(" | ")}`;
}

function formatVeniceLine(venice) {
  if (!venice) return null;
  if (!venice.available) return `• Venice [Diem]: unavailable — ${venice.error || "unknown error"}`;

  const chunks = [];
  if (venice?.data?.diem != null) chunks.push(`Diem: ${Number(venice.data.diem).toFixed(4)}`);

  const req = venice?.data?.requests;
  if (req) chunks.push(`Requests: ${req.remaining}/${req.limit} (${req.leftPercent ?? "?"}% left)`);

  const tok = venice?.data?.tokens;
  if (tok)
    chunks.push(
      `Tokens: ${Number(tok.remaining).toLocaleString()}/${Number(tok.limit).toLocaleString()} (${tok.leftPercent ?? "?"}% left)`,
    );

  if (!chunks.length) {
    const st = venice?.data?.status ? ` (HTTP ${venice.data.status})` : "";
    return `• Venice [Diem]: no balance headers returned${st}`;
  }

  return `• Venice [Diem]: ${chunks.join(" | ")}`;
}

export function formatUsageReport(snapshot, opts = {}) {
  const theme = opts.theme || "plain";
  const heading = theme === "plain" ? "Provider Quota Board" : "🌊 Tide Pools";

  const lines = [heading];
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];

  if (!providers.length) {
    lines.push("• No provider usage windows found. (Credentials/scope may be missing.)");
  } else {
    for (const p of providers) lines.push(formatProviderLine(p));
  }

  const veniceLine = formatVeniceLine(snapshot?.venice || null);
  if (veniceLine) lines.push(veniceLine);

  return lines.join("\n");
}
