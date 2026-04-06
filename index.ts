// @ts-nocheck
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

function resolveCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "cli.mjs");
}

function runCli(options: {
  theme?: "tide" | "plain";
  format?: "text" | "json";
  noVenice?: boolean;
  noEnrich?: boolean;
  noCache?: boolean;
  cacheTtlMs?: number;
  lookbackHours?: number;
  anthropicSource?: "auto" | "api" | "subscription";
}) {
  const cli = resolveCliPath();
  const flags: string[] = [];
  flags.push(`--format ${options.format || "text"}`);
  flags.push(`--theme ${options.theme || "plain"}`);
  if (options.noVenice) flags.push("--no-venice");
  if (options.noEnrich) flags.push("--no-enrich");
  if (options.noCache) flags.push("--no-cache");
  if (typeof options.cacheTtlMs === "number" && !Number.isNaN(options.cacheTtlMs)) {
    flags.push(`--cache-ttl-ms ${Math.max(0, Math.round(options.cacheTtlMs))}`);
  }
  if (typeof options.lookbackHours === "number" && !Number.isNaN(options.lookbackHours)) {
    flags.push(`--lookback-hours ${Math.max(1, Math.round(options.lookbackHours))}`);
  }
  if (options.anthropicSource) {
    flags.push(`--anthropic-source ${options.anthropicSource}`);
  }

  const cmd = `node ${JSON.stringify(cli)} ${flags.join(" ")}`;
  const text = execSync(cmd, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  return { text: text.trim() };
}

function parseQuotaArgs(raw: string | undefined) {
  const args = String(raw || "").trim();
  const has = (re: RegExp) => re.test(args);
  const matchCacheTtl = args.match(/--cache-ttl-ms\s+(\d+)/i);
  const matchLookback = args.match(/--lookback-hours\s+(\d+)/i);
  const matchAnthropicSource = args.match(/--anthropic-source\s+(auto|api|subscription)/i);

  return {
    format: has(/(?:^|\s)(--json|json)(?:\s|$)/i) ? "json" : "text",
    noVenice: has(/(?:^|\s)--no-venice(?:\s|$)/i),
    noEnrich: has(/(?:^|\s)--no-enrich(?:\s|$)/i),
    noCache: has(/(?:^|\s)--no-cache(?:\s|$)/i),
    cacheTtlMs: matchCacheTtl ? Number(matchCacheTtl[1]) : undefined,
    lookbackHours: matchLookback ? Number(matchLookback[1]) : undefined,
    anthropicSource: matchAnthropicSource ? String(matchAnthropicSource[1]).toLowerCase() as "auto" | "api" | "subscription" : undefined,
  } as const;
}

export default function register(api: any) {
  const tideHandler = async (ctx: any) => {
    try {
      const parsed = parseQuotaArgs(ctx?.args);
      return runCli({
        theme: "tide",
        format: parsed.format,
        noVenice: parsed.noVenice,
        noEnrich: parsed.noEnrich,
        noCache: parsed.noCache,
        cacheTtlMs: parsed.cacheTtlMs,
        lookbackHours: parsed.lookbackHours,
        anthropicSource: parsed.anthropicSource,
      });
    } catch (err: any) {
      return { text: `🌊 Tide Pools sonar failed.\n${err?.message || String(err)}` };
    }
  };

  api.registerCommand({
    name: "tidepools",
    description: "Tide Pools all-provider quota report with session breakdown (supports same flags as /quota_all)",
    acceptsArgs: true,
    requireAuth: true,
    handler: tideHandler,
  });

  api.registerCommand({
    name: "quota_all",
    description:
      "All provider quota windows (supports: --json, --no-venice, --no-enrich, --no-cache, --lookback-hours N, --anthropic-source auto|api|subscription)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const parsed = parseQuotaArgs(ctx?.args);
        return runCli({
          theme: "plain",
          format: parsed.format,
          noVenice: parsed.noVenice,
          noEnrich: parsed.noEnrich,
          noCache: parsed.noCache,
          cacheTtlMs: parsed.cacheTtlMs,
          lookbackHours: parsed.lookbackHours,
          anthropicSource: parsed.anthropicSource,
        });
      } catch (err: any) {
        return { text: `Quota probe failed.\n${err?.message || String(err)}` };
      }
    },
  });

  api.logger?.info?.(
    "[tide-pools] Plugin loaded v2 — /tidepools, /quota_all (adapters + enrichment)"
  );
}
