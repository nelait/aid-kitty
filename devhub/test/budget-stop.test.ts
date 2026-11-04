import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getUserByEmail } from "../src/db.js";
import { currentPeriod } from "../src/wallet.js";
import { WorkspaceService } from "../src/workspaces.js";
import { Client, FakeCloud, admin, harness, type Harness } from "./helpers.js";

const TEMPLATE = {
  imageId: "ami-0abc12345def67890",
  instanceType: "t3.xlarge",
  subnetId: "subnet-0abc1234",
  securityGroupIds: ["sg-0abc1234"],
  instanceProfile: "devhub-workspace",
  diskGb: 10,
};
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7c2x0YWJsZWtleWZvcnRlc3RzMDAwMDAwMDAwMDAw sam@laptop";
const MIN = 60_000;
const HOUR = 60 * MIN;

let h: Harness;
let cloud: FakeCloud;
let clock = Date.parse(`${currentPeriod()}-14T09:00:00Z`);
let templateId: number;
const clients: Record<string, Client> = {};

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const spend = (rows: { email: string; usd: number }[]) => admin(h.url, "POST", "/api/admin/spend-import", { tool: "codex", rows });
const beat = (machineId: string, body: unknown) =>
  fetch(`${h.url}/api/workspaces/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${/^DEVHUB_AGENT_TOKEN=(.*)$/m.exec(cloud.machines.get(machineId)!.spec.userData)![1]}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A running workspace for this person. */
async function running(who: string, name: string) {
  const c = clients[who];
  const r = await json(await c.post("/api/me/workspaces", { template_id: templateId, name }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cloud.machines.get(r.body.machine_id)!.state = "running";
  await h.sync.workspaces.reconcile();
  return r.body as { id: number; machine_id: string };
}

before(async () => {
  cloud = new FakeCloud("aws");
  h = await harness({ policyToken: "pt" }, { workspaceProviders: [cloud], now: () => clock });
  await admin(h.url, "POST", "/api/admin/users", [
    { email: "sam@acme.io", monthly_budget_usd: 100 },
    { email: "kim@acme.io", monthly_budget_usd: 100 },
    { email: "lee@acme.io", monthly_budget_usd: 10 },
    { email: "ann@acme.io", monthly_budget_usd: 100 },
    { email: "boss@acme.io", role: "admin" },
  ]);
  for (const who of ["sam", "kim", "lee", "ann"]) {
    const c = await Client.login(h.url, `${who}@acme.io`);
    const put = await fetch(`${h.url}/api/me/ssh-key`, {
      method: "PUT",
      headers: { cookie: c.cookie, "x-devhub-csrf": c.csrf, "content-type": "application/json" },
      body: JSON.stringify({ ssh_public_key: KEY }),
    });
    assert.equal(put.status, 200);
    clients[who] = c;
  }
  const t = await json(await admin(h.url, "POST", "/api/admin/workspace-templates", { name: "Standard", hourly_usd: 1, stop_after_hours: 12, idle_minutes: 0, config: TEMPLATE }));
  assert.equal(t.status, 201, JSON.stringify(t.body));
  templateId = t.body.id;
});
after(() => h.close());

test("when the budget runs out, running workspaces get a warning, then stop after the grace period", async () => {
  const w = await running("sam", "payments");
  // Nearly used up, not yet: nothing happens.
  assert.equal((await spend([{ email: "sam@acme.io", usd: 98 }])).status, 200);
  assert.equal((await h.sync.workspaces.get(w.id)).budget_stop_at, null);

  // Used up (the import triggers the check straight away): the stop is scheduled 15 minutes out.
  await spend([{ email: "sam@acme.io", usd: 100 }]);
  let ws = await h.sync.workspaces.get(w.id);
  assert.equal(ws.budget_stop_at, new Date(clock + 15 * MIN).toISOString());
  assert.equal(ws.state, "running");
  assert.ok(await h.db.get("SELECT 1 FROM audit WHERE action = 'workspace.budget_stop_scheduled'"));

  // The agent tells logged-in users, ahead of any other warning.
  clock += 30_000;
  assert.match(await (await beat(w.machine_id, { ssh: 1 })).text(), /^Dev Hub: your AI budget for this month is used up, so this workspace stops in 15 minutes\. Save your work, or ask for an increase: http/);
  clock += 2 * MIN;
  assert.equal(await (await beat(w.machine_id, { ssh: 1 })).text(), "");

  // The portal says so, and "Keep running" can't get around it.
  const page = await (await clients.sam.get("/workspaces")).text();
  assert.match(page, /Your AI budget for this month is used up, so this workspace stops at/);
  const ext = await json(await clients.sam.post(`/api/me/workspaces/${w.id}/extend`, {}));
  assert.equal(ext.status, 402);
  assert.match(ext.body.error, /ask for an increase/i);

  // Not yet at 14 minutes; stopped at 15 by the scheduled sync.
  clock = Date.parse(ws.budget_stop_at!) - MIN;
  assert.equal((await h.sync.workspaces.enforceBudgets()).stopped, 0);
  clock += MIN;
  const results = await h.sync.run();
  assert.deepEqual(
    results.find((r) => r.connector === "workspace-budget-stops"),
    { connector: "workspace-budget-stops", ok: true, message: "0 scheduled, 1 stopped, 0 cancelled" },
  );
  assert.ok(cloud.calls.includes(`stop ${w.machine_id}`));
  ws = await h.sync.workspaces.get(w.id);
  assert.equal(ws.state, "stopping");
  assert.equal(ws.detail, "Stopped because the AI budget for this month is used up.");
  assert.equal(ws.budget_stop_at, null);
  assert.equal((await h.db.get<{ actor: string }>("SELECT actor FROM audit WHERE action = 'workspace.budget_stopped'"))!.actor, "system");

  // And it can't be started again until the budget is raised.
  cloud.machines.get(w.machine_id)!.state = "stopped";
  await h.sync.workspaces.reconcile();
  assert.equal((await clients.sam.post(`/api/me/workspaces/${w.id}/start`, {})).status, 402);
});

test("a budget increase during the grace period cancels the stop", async () => {
  const w = await running("kim", "search");
  await spend([{ email: "kim@acme.io", usd: 100 }]);
  assert.ok((await h.sync.workspaces.get(w.id)).budget_stop_at);

  // An admin raises Kim's budget (an approved increase request takes the same path).
  await admin(h.url, "POST", "/api/admin/users", [{ email: "kim@acme.io", monthly_budget_usd: 200 }]);
  const ws = await h.sync.workspaces.get(w.id);
  assert.equal(ws.budget_stop_at, null);
  assert.ok(await h.db.get("SELECT 1 FROM audit WHERE action = 'workspace.budget_stop_cancelled'"));
  clock += HOUR;
  assert.equal((await h.sync.workspaces.enforceBudgets()).stopped, 0);
  assert.equal((await h.sync.workspaces.get(w.id)).state, "running");
  // "Keep running" works again.
  assert.equal((await clients.kim.post(`/api/me/workspaces/${w.id}/extend`, {})).status, 200);
});

test("the workspace's own running time counts, even before the next sync records it", async () => {
  // Lee has $10 and a $1/hour workspace; nothing else. No sync runs in between.
  const w = await running("lee", "infra");
  clock += 9 * HOUR;
  assert.equal((await h.sync.workspaces.enforceBudgets()).scheduled, 0);
  clock += HOUR;
  const r = await h.sync.workspaces.enforceBudgets();
  assert.equal(r.scheduled, 1);
  assert.equal(r.stopped, 0);
  clock += 15 * MIN;
  assert.equal((await h.sync.workspaces.enforceBudgets()).stopped, 1);
  assert.equal((await h.sync.workspaces.get(w.id)).state, "stopping");
});

test("deactivating someone stops their workspaces straight away", async () => {
  const w = await running("ann", "mlops");
  await admin(h.url, "POST", "/api/admin/users", [{ email: "ann@acme.io", status: "disabled" }]);
  const ws = await h.sync.workspaces.get(w.id);
  assert.equal(ws.state, "stopping");
  assert.equal(ws.detail, "Stopped because its owner no longer has access to Dev Hub.");
  // The admin page notes a pending budget stop in the auto-stop column; nothing is pending now.
  const boss = await Client.login(h.url, "boss@acme.io");
  assert.doesNotMatch(await (await boss.get("/admin/workspaces")).text(), /Budget used up:/);
});

test("the admin page shows a pending budget stop; the used-up email mentions workspaces", async () => {
  const kim = (await getUserByEmail(h.db, "kim@acme.io"))!;
  const w = (await h.sync.workspaces.listFor(kim.id)).find((x) => x.name === "search")!;
  await spend([{ email: "kim@acme.io", usd: 250 }]);
  assert.ok((await h.sync.workspaces.get(w.id)).budget_stop_at);
  const boss = await Client.login(h.url, "boss@acme.io");
  assert.match(await (await boss.get("/admin/workspaces")).text(), /<strong>Budget used up:<\/strong> \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  const mail = h.emails.find((m) => m.to.includes("kim@acme.io") && /is used up/.test(m.subject));
  assert.ok(mail, "Kim got the used-up email");
  assert.match(mail.text, /Running workspaces stop in 15 minutes; save your work\./);
});

test("budget stops can be turned off", async () => {
  const off = await harness({ workspaces: { stopWhenBudgetUsedUp: false } }, { workspaceProviders: [new FakeCloud("aws")] });
  try {
    assert.deepEqual(await off.sync.workspaces.enforceBudgets(), { scheduled: 0, stopped: 0, cancelled: 0 });
  } finally {
    await off.close();
  }
  assert.throws(() => new WorkspaceService(h.db, { ...h.cfg, workspaces: { budgetGraceMinutes: 1.5 } }, [new FakeCloud("aws")]), /budgetGraceMinutes/);
});
