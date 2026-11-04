import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getUserByEmail } from "../src/db.js";
import { Client, admin, harness, testLicense, type Harness } from "./helpers.js";

let h: Harness;
let boss: Client;
before(async () => {
  h = await harness();
  await admin(h.url, "POST", "/api/admin/users", { email: "boss@acme.io", role: "admin" });
  boss = await Client.login(h.url, "boss@acme.io");
});
after(() => h.close());

const html = async (c: Client, path: string) => {
  const res = await c.get(path);
  return { status: res.status, text: await res.text() };
};

test("admin pages are for admins only, and every form needs the CSRF token", async () => {
  const dev = await Client.login(h.url, "dev@acme.io");
  for (const path of ["/admin/people", "/admin/teams", "/admin/unmatched", "/admin/license"]) {
    assert.equal((await dev.get(path)).status, 403, path);
    assert.equal((await boss.get(path)).status, 200, path);
  }
  assert.equal((await fetch(`${h.url}/admin/people`, { redirect: "manual" })).status, 302);
  const r = await boss.form("/admin/people/new", { email: "x@acme.io" }, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(await getUserByEmail(h.db, "x@acme.io"), undefined);
});

test("teams: add one, then edit its budgets", async () => {
  let r = await boss.form("/admin/teams/new", { name: "platform", cost_center: "CC-100", member_default_usd: "200", monthly_pool_usd: "" });
  assert.equal(r.msg, "Added team platform.");
  const team = (await h.db.get<{ id: number; member_default_cents: number; monthly_pool_cents: number | null }>(
    "SELECT * FROM teams WHERE name = 'platform'",
  ))!;
  assert.equal(team.member_default_cents, 20000);
  assert.equal(team.monthly_pool_cents, null);
  r = await boss.form("/admin/teams/new", { name: "platform" });
  assert.match(r.msg!, /already exists/);
  const page = await html(boss, `/admin/teams/${team.id}`);
  assert.match(page.text, /value="200"/);
});

test("people: add one, refuse a duplicate, import a CSV", async () => {
  let r = await boss.form("/admin/people/new", { email: "Priya@Acme.io", name: "Priya Shah", team: "platform", role: "manager", github_login: "", monthly_budget_usd: "" });
  assert.equal(r.msg, "Added priya@acme.io.");
  const priya = (await getUserByEmail(h.db, "priya@acme.io"))!;
  assert.equal(priya.role, "manager");
  assert.equal(priya.monthly_budget_cents, null);
  r = await boss.form("/admin/people/new", { email: "priya@acme.io" });
  assert.match(r.msg!, /already exists/);

  r = await boss.form("/admin/people/import", {
    csv: 'email,name,team,github_login,monthly_budget_usd\r\nsam@acme.io,"Okafor, Sam",platform,SamDev,450\nlee@acme.io,Lee,,,\n',
  });
  assert.equal(r.msg, "Imported 2 people.");
  const sam = (await getUserByEmail(h.db, "sam@acme.io"))!;
  assert.equal(sam.name, "Okafor, Sam");
  assert.equal(sam.github_login, "samdev");
  assert.equal(sam.monthly_budget_cents, 45000);
  assert.equal((await getUserByEmail(h.db, "lee@acme.io"))!.team_id, null);

  r = await boss.form("/admin/people/import", { csv: "email,favourite_colour\na@acme.io,blue" });
  assert.match(r.msg!, /unknown CSV columns: favourite_colour/);
  r = await boss.form("/admin/people/import", { csv: "email,team\na@acme.io,nope" });
  assert.match(r.msg!, /unknown team "nope"/);
  assert.equal(await getUserByEmail(h.db, "a@acme.io"), undefined); // the bad import saved nothing

  const list = await html(boss, "/admin/people?q=okafor");
  // Match result links only (the CSV example placeholder also mentions priya@acme.io).
  assert.match(list.text, />sam@acme\.io<\/a>/);
  assert.doesNotMatch(list.text, />priya@acme\.io<\/a>/);
});

test("editing a person updates their budget and Claude cap; clearing the budget falls back to the team's", async () => {
  const sam = await Client.login(h.url, "sam@acme.io"); // links an SSO identity, so Sam gets a Claude cap
  const sub = (await getUserByEmail(h.db, "sam@acme.io"))!.oidc_sub!;
  const id = (await getUserByEmail(h.db, "sam@acme.io"))!.id;
  let r = await boss.form(`/admin/people/${id}`, {
    name: "Sam Okafor", team: "platform", role: "member", status: "active",
    monthly_budget_usd: "600", github_login: "samdev", claude_user_id: "",
  });
  assert.equal(r.msg, "Saved.");
  assert.equal(h.claude.caps.get(sub), "60000");
  r = await boss.form(`/admin/people/${id}`, {
    name: "Sam Okafor", team: "platform", role: "member", status: "active",
    monthly_budget_usd: "", github_login: "samdev", claude_user_id: "",
  });
  assert.equal((await getUserByEmail(h.db, "sam@acme.io"))!.monthly_budget_cents, null);
  assert.equal(h.claude.caps.get(sub), "20000"); // the platform team's per-person budget
  assert.equal((await sam.get("/api/me")).status, 200);

  // Disabling ends their session and zeroes the cap.
  await boss.form(`/admin/people/${id}`, { name: "Sam Okafor", team: "platform", role: "member", status: "disabled", monthly_budget_usd: "", github_login: "samdev", claude_user_id: "" });
  assert.equal((await sam.get("/api/me")).status, 401);
  assert.equal(h.claude.caps.get(sub), "0");
});

test("an admin can't demote or disable themselves", async () => {
  const id = (await getUserByEmail(h.db, "boss@acme.io"))!.id;
  const r = await boss.form(`/admin/people/${id}`, { name: "", team: "", role: "member", status: "active", monthly_budget_usd: "", github_login: "", claude_user_id: "" });
  assert.match(r.msg!, /can't change your own role/);
  assert.equal((await getUserByEmail(h.db, "boss@acme.io"))!.role, "admin");
  const page = await html(boss, `/admin/people/${id}`);
  assert.match(page.text, /<select name="role" disabled>/);
});

test("unmatched spend: link a Claude identity and a GitHub login to people", async () => {
  h.claude.spend.set("okta|contractor-7", 1500);
  h.github.seats = [{ login: "lee-gh", plan: "business" }];
  h.cursor.members = [{ email: "temp@agency.io", spendCents: 300 }];
  await h.sync.run();
  let page = await html(boss, "/admin/unmatched");
  assert.match(page.text, /okta\|contractor-7/);
  assert.match(page.text, /lee-gh/);
  assert.match(page.text, /Matched by email/); // the Cursor row

  const lee = (await getUserByEmail(h.db, "lee@acme.io"))!;
  let r = await boss.form("/admin/unmatched/link", { tool: "copilot", external_id: "lee-gh", user_id: String(lee.id) });
  assert.equal(r.msg, "Linked to lee@acme.io. Their spend is updated.");
  assert.equal((await getUserByEmail(h.db, "lee@acme.io"))!.github_login, "lee-gh");
  const spend = await h.db.get<{ cents: number }>("SELECT cents FROM spend WHERE user_id = ? AND tool = 'copilot'", lee.id);
  assert.equal(spend?.cents, 1900);

  r = await boss.form("/admin/unmatched/link", { tool: "claude", external_id: "okta|contractor-7", user_id: String(lee.id) });
  assert.equal((await getUserByEmail(h.db, "lee@acme.io"))!.claude_user_id, "okta|contractor-7");
  page = await html(boss, "/admin/unmatched");
  assert.doesNotMatch(page.text, /contractor-7/);

  r = await boss.form("/admin/unmatched/link", { tool: "cursor", external_id: "temp@agency.io", user_id: String(lee.id) });
  assert.match(r.msg!, /matched by email/);
  r = await boss.form("/admin/unmatched/link", { tool: "claude", external_id: "x", user_id: "" });
  assert.equal(r.msg, "Choose a person.");
});

test("license page: a tampered file is refused, a valid one is installed", async () => {
  const tampered = JSON.parse(testLicense(25));
  tampered.license.seats = 9999;
  let r = await boss.form("/admin/license", { license_file: JSON.stringify(tampered) });
  assert.match(r.msg!, /signature/);
  r = await boss.form("/admin/license", { license_file: testLicense(25, 365, "Globex") });
  assert.equal(r.msg, "License installed.");
  const page = await html(boss, "/admin/license");
  assert.match(page.text, /Globex/);
  assert.match(page.text, /25 \(up to 27 with true-up\)/);
});

test("user-controlled text is escaped on admin pages", async () => {
  await boss.form("/admin/people/new", { email: "evil@acme.io", name: "<img src=x onerror=alert(1)>" });
  const page = await html(boss, "/admin/people");
  assert.ok(!page.text.includes("<img src=x"));
  assert.ok(page.text.includes("&lt;img src=x"));
});
