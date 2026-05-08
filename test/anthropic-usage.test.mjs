import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsage, providerFromParsed, parseResetTime } from "../adapters/anthropic-cli-usage.mjs";

test("anthropic: parses subscription 5h/week remaining and extra usage balance", () => {
  const now = new Date("2026-05-06T04:00:00.000Z");
  const raw = `
Claude Max

Current session
35% used
Resets 8:30am

Current week (all models)
72% used
Resets May 10, 11:59pm

Extra usage
enabled
$3.25 / $5.00 spent
Resets May 31
`;

  const parsed = parseUsage(raw, now);
  assert.equal(parsed.mode, "subscription");
  assert.equal(parsed.fiveHour.pctUsed, 35);
  assert.equal(parsed.fiveHour.pctRemaining, 65);
  assert.equal(parsed.week.pctUsed, 72);
  assert.equal(parsed.week.pctRemaining, 28);
  assert.equal(parsed.extra.status, "enabled");
  assert.equal(parsed.extra.spentUsd, 3.25);
  assert.equal(parsed.extra.limitUsd, 5);
  assert.equal(parsed.extra.availableUsd, 1.75);
  assert.equal(parsed.extra.overUsd, 0);

  const provider = providerFromParsed(parsed);
  assert.equal(provider.provider, "anthropic");
  assert.equal(provider.plan, "subscription");

  const byLabel = Object.fromEntries(provider.windows.map((w) => [w.label, w]));
  assert.equal(byLabel["5h"].leftPercent, 65);
  assert.equal(byLabel.week.leftPercent, 28);
  assert.equal(byLabel.extra.status, "enabled");
  assert.equal(byLabel.extra.availableUsd, 1.75);
});

test("anthropic: parses exhausted extra usage and over-balance", () => {
  const now = new Date("2026-05-06T04:00:00.000Z");
  const raw = `
Claude Pro

Current 5-hour window
100% used
Resets 6:00am

Current week
81% used
Resets May 11

Extra usage
out of extra usage
$7.50 / $5.00 spent
Resets May 31
`;

  const parsed = parseUsage(raw, now);
  assert.equal(parsed.mode, "subscription");
  assert.equal(parsed.fiveHour.pctRemaining, 0);
  assert.equal(parsed.week.pctRemaining, 19);
  assert.equal(parsed.extra.status, "exhausted");
  assert.equal(parsed.extra.availableUsd, 0);
  assert.equal(parsed.extra.overUsd, 2.5);

  const provider = providerFromParsed(parsed);
  const extra = provider.windows.find((w) => w.label === "extra");
  assert.equal(extra.status, "exhausted");
  assert.equal(extra.availableUsd, 0);
  assert.equal(extra.overUsd, 2.5);
});

test("anthropic: parses UTC reset dates without rolling future dates backwards", () => {
  const now = new Date("2026-05-06T04:00:00.000Z");
  const sameDayFuture = parseResetTime("8:30am", now);
  const dateFuture = parseResetTime("May 10, 11:59pm", now);
  const twentyFourHour = parseResetTime("15:30", now);

  assert.equal(sameDayFuture?.toISOString(), "2026-05-06T08:30:00.000Z");
  assert.equal(dateFuture?.toISOString(), "2026-05-10T23:59:00.000Z");
  assert.equal(twentyFourHour?.toISOString(), "2026-05-06T15:30:00.000Z");
});

test("anthropic: parses parenthetical 5h heading variants", () => {
  const raw = `
Claude Pro

Current Session (Pro)
68% used
Resets 15:30

Current Week (all models)
12% used
Resets May 10, 12:00 am
`;

  const parsed = parseUsage(raw, new Date("2026-05-06T10:00:00.000Z"));
  assert.equal(parsed.mode, "subscription");
  assert.equal(parsed.fiveHour.pctUsed, 68);
  assert.equal(parsed.fiveHour.pctRemaining, 32);
  assert.equal(parsed.fiveHour.resetAtIso, "2026-05-06T15:30:00.000Z");
});

test("anthropic: parses extra usage money when label says used instead of spent", () => {
  const raw = `
Claude Pro

Current Session
20% used
Resets May 7, 3:00 am

Current Week (all models)
5% used
Resets May 10, 12:00 am

Extra Usage
enabled
$3.50 / $25.00 used
`;

  const parsed = parseUsage(raw, new Date("2026-05-06T10:00:00.000Z"));
  assert.equal(parsed.extra.status, "enabled");
  assert.equal(parsed.extra.spentUsd, 3.5);
  assert.equal(parsed.extra.limitUsd, 25);
  assert.equal(parsed.extra.availableUsd, 21.5);
});

test("anthropic: omitted Extra Usage section stays absent", () => {
  const raw = `
Claude Pro

Current session
55% used
Resets 8:20am (UTC)

Current week (all models)
72% used
Resets May 8, 1pm (UTC)
`;

  const parsed = parseUsage(raw, new Date("2026-05-06T04:20:00.000Z"));
  assert.equal(parsed.mode, "subscription");
  assert.equal(parsed.extra, null);

  const provider = providerFromParsed(parsed);
  const extra = provider.windows.find((w) => w.label === "extra");
  assert.equal(extra, undefined);
});

test("anthropic: exhausted extra usage without dollar data still surfaces", () => {
  const raw = `
Claude Pro

Current session
80% used
Resets 9:00am (UTC)

Current week (all models)
60% used
Resets May 10, 1pm (UTC)

You are out of extra usage
`;

  const parsed = parseUsage(raw, new Date("2026-05-06T04:00:00.000Z"));
  assert.equal(parsed.mode, "subscription");
  assert.equal(parsed.extra.status, "exhausted");

  const provider = providerFromParsed(parsed);
  const extra = provider.windows.find((w) => w.label === "extra");
  assert.ok(extra, "exhausted extra window should appear even without dollar data");
  assert.equal(extra.status, "exhausted");
  assert.equal(extra.spentUsd, null);
  assert.equal(extra.limitUsd, null);
});
