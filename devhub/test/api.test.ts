import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getUserByEmail } from "../src/db.js";
import { Client, admin, harness, type Harness } from "./helpers.js";

let h: Harness;
before(async () => {
  h = await harness();
  // Onboard a 4-person company with the automation token, the way Terraform or a script would.
  let res = await admin(h.url, "POST", "/api/admin/teams", { name: "platform", cost_center: "CC-100", member_default_usd: 200 });
  assert.equal(res.status, 201);
  res = await admin(h.url, "POST", "/api/admin/teams", { name: "mobile", cost_center: "CC-200" });
  assert.equal(res.status, 201);
  res = await admin(h.url, "POST", "/api/admin/users", [
    { email: "lead@acme.io", team: "platform", role: "manager" },
    { email: "dev@acme.io", team: "platform", github_login: "dev-gh" },
    { email: "mob@acme.io", team: "mobile" },
    { email: "boss@acme.io", role: "admin" },
  ]);
  assert.equal(res.status, 201, await res.text());
});
after(() => h.close());

test("unauthenticated and non-admin callers are refused", async () => {
  assert.equal((await fetch(`${h.url}/api/me`)).status, 401);
  assert.equal((await fetch(`${h.url}/api/admin/users`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  const dev = await Client.login(h.url, "dev@acme.io");
  assert.equal((await dev.get("/api/admin/users")).status, 403);
  assert.equal((await dev.get("/admin")).status, 403);
});

test("SSO login links to the user an admin created, and the wallet uses the team default", async () => {
  const dev = await Client.login(h.url, "dev@acme.io");
  const me = await (await dev.get("/api/me")).json();
  assert.equal(me.user.team_id !== null, true);
  assert.equal(me.user.sso_linked, true);
  assert.equal(me.wallet.limitCents, 20000);
});

test("writes without the CSRF token are rejected", async () => {
  const dev = await Client.login(h.url, "dev@acme.io");
  const res = await dev.post("/api/me/raise-requests", { amount_usd: 50, reason: "big refactor" }, { csrf: false });
  assert.equal(res.status, 403);
});

test("raise request → manager approval → Claude cap goes up immediately", async () => {
  const dev = await Client.login(h.url, "dev@acme.io");
  const lead = await Client.login(h.url, "lead@acme.io");
  const mob = await Client.login(h.url, "mob@acme.io");
  const sub = getUserByEmail(h.db, "dev@acme.io")!.oidc_sub!;

  let res = await dev.post("/api/me/raise-requests", { amount_usd: 50, reason: "migration sprint" });
  assert.equal(res.status, 201);
  const rq = await res.json();

  // The requester cannot approve their own request, and other teams' members cannot either.
  assert.equal((await dev.post(`/api/raise-requests/${rq.id}/approve`, {})).status, 403);
  assert.equal((await mob.post(`/api/raise-requests/${rq.id}/approve`, {})).status, 403);

  // The platform manager sees it and approves it.
  const pending = await (await lead.get("/api/raise-requests")).json();
  assert.deepEqual(pending.map((p: { id: number }) => p.id), [rq.id]);
  res = await lead.post(`/api/raise-requests/${rq.id}/approve`, { note: "ok for this sprint" });
  const decided = await res.json();
  assert.equal(res.status, 200, JSON.stringify(decided));
  assert.equal(decided.status, "approved");

  // Wallet 200 + 50, nothing spent: the Claude cap is 250.00.
  assert.equal(h.claude.caps.get(sub), "25000");
  const me = await (await dev.get("/api/me")).json();
  assert.equal(me.wallet.limitCents, 25000);

  // Deciding twice is a conflict.
  assert.equal((await lead.post(`/api/raise-requests/${rq.id}/deny`, {})).status, 409);
});

test("validation errors come back as 400s with a message", async () => {
  const dev = await Client.login(h.url, "dev@acme.io");
  const res = await dev.post("/api/me/raise-requests", { amount_usd: -5, reason: "x" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /amount/);
  const bad = await admin(h.url, "POST", "/api/admin/users", { email: "x@acme.io", team: "nope" });
  assert.equal(bad.status, 400);
});

test("manually imported spend (a tool with no connector) shrinks the Claude cap", async () => {
  const sub = getUserByEmail(h.db, "dev@acme.io")!.oidc_sub!;
  const res = await admin(h.url, "POST", "/api/admin/spend-import", {
    tool: "codex",
    rows: [
      { email: "dev@acme.io", usd: 40 },
      { email: "nobody@acme.io", usd: 5 },
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).unknown_emails, ["nobody@acme.io"]);
  await new Promise((r) => setTimeout(r, 50)); // cap push runs in the background
  assert.equal(h.claude.caps.get(sub), "21000");
  // A tool that has a connector can't be overwritten by hand.
  assert.equal((await admin(h.url, "POST", "/api/admin/spend-import", { tool: "claude", rows: [] })).status, 409);
});

test("chargeback CSV has one column per tool and neutralizes formula injection", async () => {
  await admin(h.url, "POST", "/api/admin/users", { email: "evil@acme.io", name: "=HYPERLINK(\"http://x\")" });
  const res = await admin(h.url, "GET", "/api/admin/report?format=csv");
  assert.equal(res.status, 200);
  const csv = await res.text();
  const [head, ...rows] = csv.trim().split("\n");
  assert.equal(head, "email,name,team,cost_center,codex_usd,total_usd,limit_usd");
  assert.ok(rows.some((r) => r.startsWith("dev@acme.io,,platform,CC-100,40.00,40.00,250.00")), csv);
  assert.ok(rows.some((r) => r.includes(`"'=HYPERLINK(""http://x"")"`)), csv);
});

test("portal pages render and escape user-controlled text", async () => {
  const dev = await Client.login(h.url, "dev@acme.io");
  await dev.post("/api/me/raise-requests", { amount_usd: 10, reason: "<script>alert(1)</script>" });
  const home = await (await dev.get("/")).text();
  assert.match(home, /AI budget for/);
  assert.ok(!home.includes("<script>alert(1)</script>"));
  assert.ok(home.includes("&lt;script&gt;"));
  const boss = await Client.login(h.url, "boss@acme.io");
  const adminPage = await boss.get("/admin");
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /Download chargeback CSV/);
});

test("disabling a user ends their sessions", async () => {
  const mob = await Client.login(h.url, "mob@acme.io");
  assert.equal((await mob.get("/api/me")).status, 200);
  await admin(h.url, "POST", "/api/admin/users", { email: "mob@acme.io", status: "disabled" });
  assert.equal((await mob.get("/api/me")).status, 401);
  // And they can't sign back in.
  await assert.rejects(Client.login(h.url, "mob@acme.io"), /login failed: 403/);
});
