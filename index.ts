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
  noCache?: boolean;
  cacheTtlMs?: number;
}) {
  const cli = resolveCliPath();
  const flags: string[] = [];
  flags.push(`--format ${options.format || "text"}`);
  flags.push(`--theme ${options.theme || "plain"}`);
  if (options.noVenice) flags.push("--no-venice");
  if (options.noCache) flags.push("--no-cache");
  if (typeof options.cacheTtlMs === "number" && !Number.isNaN(options.cacheTtlMs)) {
    flags.push(`--cache-ttl-ms ${Math.max(0, Math.round(options.cacheTtlMs))}`);
  }

  const cmd = `node ${JSON.stringify(cli)} ${flags.join(" ")}`;
  const text = execSync(cmd, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  return { text: text.trim() };
}

function parseQuotaArgs(raw: string | undefined) {
  const args = String(raw || "").trim();
  const has = (re: RegExp) => re.test(args);
  const match = args.match(/--cache-ttl-ms\s+(\d+)/i);

  return {
    format: has(/(?:^|\s)(--json|json)(?:\s|$)/i) ? "json" : "text",
    noVenice: has(/(?:^|\s)--no-venice(?:\s|$)/i),
    noCache: has(/(?:^|\s)--no-cache(?:\s|$)/i),
    cacheTtlMs: match ? Number(match[1]) : undefined,
  } as const;
}

export default function register(api: any) {
  const tideHandler = async () => {
    try {
      return runCli({ theme: "tide", format: "text" });
    } catch (err: any) {
      return { text: `🌊 Tide Pools sonar failed.\n${err?.message || String(err)}` };
    }
  };

  api.registerCommand({
    name: "tide_pools",
    description: "Tide Pools all-provider quota report (no LLM inference)",
    acceptsArgs: false,
    requireAuth: true,
    handler: tideHandler,
  });

  api.registerCommand({
    name: "tidepools",
    description: "Alias for /tide_pools",
    acceptsArgs: false,
    requireAuth: true,
    handler: tideHandler,
  });

  // Backward compatibility alias
  api.registerCommand({
    name: "lobster_usage",
    description: "Alias for /tide_pools",
    acceptsArgs: false,
    requireAuth: true,
    handler: tideHandler,
  });

  api.registerCommand({
    name: "quota_all",
    description: "All provider quota windows (supports: --json, --no-venice, --no-cache)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const parsed = parseQuotaArgs(ctx?.args);
        return runCli({
          theme: "plain",
          format: parsed.format,
          noVenice: parsed.noVenice,
          noCache: parsed.noCache,
          cacheTtlMs: parsed.cacheTtlMs,
        });
      } catch (err: any) {
        return { text: `Quota probe failed.\n${err?.message || String(err)}` };
      }
    },
  });

  api.logger?.info?.(
    "[tide-pools] Plugin loaded - /tide_pools (/tidepools, /lobster_usage aliases) and /quota_all registered (standalone; cache+json)",
  );
}
