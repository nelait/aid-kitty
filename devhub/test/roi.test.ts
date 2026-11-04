import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { OutputService, periodRange, previousPeriod } from "../src/output.js";
import { roiReport } from "../src/roi.js";
import { currentPeriod } from "../src/wallet.js";
import { Client, admin, harness, type Harness } from "./helpers.js";

test("month ranges and the previous month", () => {
  assert.deepEqual(periodRange("2028-02"), { start: "2028-02-01", end: "2028-02-29" });
  assert.deepEqual(periodRange("2026-11"), { start: "2026-11-01", end: "2026-11-30" });
  assert.equal(previousPeriod("2026-01"), "2025-12");
});

let h: Harness;
const period = currentPeriod();
before(async () => {
  h = await harness();
  await admin(h.url, "POST", "/api/admin/teams", { name: "platform", cost_center: "CC-100" });
  await admin(h.url, "POST", "/api/admin/teams", { name: "mobile" });
  await admin(h.url, "POST", "/api/admin/users", [
    { email: "boss@acme.io", role: "admin" },
    { email: "ana@acme.io", team: "platform", github_login: "ana-gh" },
    { email: "ben@acme.io", team: "platform", github_login: "ben-gh" },
    { email: "cy@acme.io", team: "mobile", github_login: "cy-gh" },
    { email: "dee@acme.io", team: "mobile" }, // no GitHub login
  ]);
  await admin(h.url, "POST", "/api/admin/spend-import", {
    tool: "codex",
    rows: [
      { email: "ana@acme.io", usd: 300 },
      { email: "ben@acme.io", usd: 100 },
      { email: "cy@acme.io", usd: 50 },
      { email: "dee@acme.io", usd: 50 },
    ],
  });
});
after(() => h.close());

test("before PRs are counted, the report shows spend with no per-PR figure", async () => {
  const r = await roiReport(h.db, period);
  assert.equal(r.org.spendCents, 50000);
  assert.equal(r.org.mergedPrs, 0);
  assert.equal(r.org.centsPerPr, null);
  assert.equal(r.org.orgMergedPrs, null);
});

test("counting merged PRs: one search per person with a GitHub login, plus org totals", async () => {
  h.github.mergedPrs = new Map([["ana-gh", 30], ["ben-gh", 10], ["cy-gh", 10]]);
  h.github.orgMerged = 75;
  h.github.claudeMarked = 22;
  const [res] = await h.sync.output.refresh(period);
  assert.equal(res.complete, true);
  assert.equal(res.people, 3); // dee has no login, boss has none either
  const { start, end } = periodRange(period);
  assert.ok(h.github.searches.includes(`org:acme is:pull-request is:merged merged:${start}..${end}`));
  assert.ok(h.github.searches.includes(`org:acme is:pull-request is:merged merged:${start}..${end} author:ana-gh`));

  const r = await roiReport(h.db, period);
  assert.equal(r.org.mergedPrs, 50);
  assert.equal(r.org.centsPerPr, 900); // $450 of linked spend / 50 PRs (dee's $50 can't be tied to PRs)
  assert.equal(r.org.orgMergedPrs, 75);
  assert.equal(r.org.claudeMarkedPrs, 22);
  assert.equal(r.org.unlinkedSpenders, 1);
  assert.equal(r.org.unlinkedSpendCents, 5000);

  const platform = r.teams.find((t) => t.team === "platform")!;
  assert.equal(platform.spendCents, 40000);
  assert.equal(platform.mergedPrs, 40);
  assert.equal(platform.centsPerPr, 1000);
  assert.equal(platform.spendShare, 0.8);
  assert.equal(platform.prShare, 0.8);
  const mobile = r.teams.find((t) => t.team === "mobile")!;
  assert.equal(mobile.spendCents, 10000); // dee's $50 is in the team's spend...
  assert.equal(mobile.centsPerPr, 500); // ...but not in per-PR: only cy's $50 / 10 PRs
  assert.equal(r.trend.length, 6);
  assert.equal(r.trend.at(-1)!.period, period);
  assert.equal(r.trend.at(-1)!.mergedPrs, 50);
  assert.equal(r.trend.at(-1)!.centsPerPr, 900);
  assert.equal(r.people.find((p) => p.email === "dee@acme.io")!.centsPerPr, null);
});

test("hitting the search rate limit keeps what was counted and marks the month incomplete", async () => {
  h.github.searches = [];
  h.github.rateLimitAfter = 3; // org total, Claude-marked, one person
  h.github.mergedPrs.set("ana-gh", 31);
  const [res] = await h.sync.output.refresh(period);
  assert.equal(res.complete, false);
  assert.match(res.message, /rate limit.*counted 1 of 3 people/);
  assert.equal((await roiReport(h.db, period)).people.find((p) => p.email === "ana@acme.io")!.mergedPrs, 31);
  // An incomplete month is due again on the next check.
  h.github.rateLimitAfter = null;
  const again = await h.sync.output.refreshIfDue();
  assert.ok(again.some((x) => x.period === period && x.complete));
});

test("refreshes are paced: current month every few hours, last month once more after it ends", async () => {
  await h.db.run("DELETE FROM settings WHERE key LIKE 'output:%'"); // start with nothing refreshed
  let now = Date.parse(`${period}-15T12:00:00Z`);
  const out = new OutputService(h.db, h.cfg, () => now);
  const prev = previousPeriod(period);
  let ran = await out.refreshIfDue();
  assert.deepEqual(ran.map((r) => r.period).sort(), [prev, period].sort());
  ran = await out.refreshIfDue();
  assert.deepEqual(ran, []); // both fresh
  now += 6 * 3_600_000;
  ran = await out.refreshIfDue();
  assert.deepEqual(ran.map((r) => r.period), [period]); // last month was finalized after it ended
});

test("the portal page shows team and org numbers, caveats, and keeps people collapsed", async () => {
  const boss = await Client.login(h.url, "boss@acme.io");
  const html = await (await boss.get("/admin/roi")).text();
  assert.match(html, /Return on spend:/);
  assert.match(html, /Spend per merged PR/);
  assert.match(html, /not a measure of anyone's productivity/);
  assert.match(html, /<details><summary><b>By person<\/b>/);
  assert.match(html, /1 person spent \$50\.00 without a GitHub login/);
  const r = await boss.form("/admin/roi/refresh", { period });
  assert.match(r.location, new RegExp(`^/admin/roi\\?period=${period}&msg=`));
  assert.match(r.msg!, /Counting merged PRs in the background/);
  const cara = await Client.login(h.url, "ana@acme.io");
  assert.equal((await cara.get("/admin/roi")).status, 403);
});

test("CSV export has org, team and person rows", async () => {
  const csv = await (await admin(h.url, "GET", `/api/admin/roi?format=csv&period=${period}`)).text();
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "level,name,team,spend_usd,merged_prs,usd_per_merged_pr");
  assert.ok(lines.includes("team,platform,platform,400.00,41,9.76"), csv);
  assert.ok(lines.includes("team,mobile,mobile,100.00,10,5.00"), csv);
  assert.ok(lines.some((l) => l.startsWith("person,dee@acme.io,mobile,50.00,0,")), csv);
  assert.equal((await admin(h.url, "GET", "/api/admin/roi?period=bad")).status, 400);
});
