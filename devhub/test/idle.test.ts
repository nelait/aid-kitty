import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { getUserByEmail } from "../src/db.js";
import { currentPeriod } from "../src/wallet.js";
import { Client, FakeCloud, admin, harness, type Harness } from "./helpers.js";

const TEMPLATE = {
  imageId: "ami-0abc12345def67890",
  instanceType: "t3.xlarge",
  subnetId: "subnet-0abc1234",
  securityGroupIds: ["sg-0abc1234"],
  instanceProfile: "devhub-workspace",
  diskGb: 50,
};
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7c2x0YWJsZWtleWZvcnRlc3RzMDAwMDAwMDAwMDAw sam@laptop";
const MIN = 60_000;

/** A backend that tracks activity itself, the way Coder does. */
class TrackingCloud extends FakeCloud {
  seen = new Map<string, string>();
  lastActiveAt(id: string) {
    return this.seen.get(id);
  }
}

let h: Harness;
let aws: FakeCloud;
let coder: TrackingCloud;
let clock = Date.parse(`${currentPeriod()}-12T09:00:00Z`);
let sam: Client;
let kim: Client;
const ids: Record<string, number> = {};

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const beat = (token: string, body: unknown) =>
  fetch(`${h.url}/api/workspaces/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const tokenOf = (machineId: string) => /^DEVHUB_AGENT_TOKEN=(.*)$/m.exec(aws.machines.get(machineId)!.spec.userData)![1];

async function create(c: Client, name: string, template: string) {
  const r = await json(await c.post("/api/me/workspaces", { template_id: ids[template], name }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { id: number; machine_id: string };
}

before(async () => {
  aws = new FakeCloud("aws");
  coder = new TrackingCloud("coder", false);
  h = await harness({ policyToken: "pt" }, { workspaceProviders: [aws, coder], now: () => clock });
  await admin(h.url, "POST", "/api/admin/users", [{ email: "sam@acme.io", monthly_budget_usd: 500 }, { email: "kim@acme.io", monthly_budget_usd: 500 }]);
  sam = await Client.login(h.url, "sam@acme.io");
  kim = await Client.login(h.url, "kim@acme.io");
  for (const c of [sam, kim]) {
    const put = await fetch(`${h.url}/api/me/ssh-key`, {
      method: "PUT",
      headers: { cookie: c.cookie, "x-devhub-csrf": c.csrf, "content-type": "application/json" },
      body: JSON.stringify({ ssh_public_key: KEY }),
    });
    assert.equal(put.status, 200);
  }
});
after(() => h.close());

test("templates carry an idle limit: 30 minutes by default, 0 for never, nothing under 10", async () => {
  const post = (b: Record<string, unknown>) => admin(h.url, "POST", "/api/admin/workspace-templates", { provider: "aws", hourly_usd: 0.2, stop_after_hours: 8, config: TEMPLATE, ...b });
  let r = await json(await post({ name: "Too eager", idle_minutes: 5 }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 10/);
  assert.equal((await post({ name: "Too long", idle_minutes: 600 })).status, 400);
  r = await json(await post({ name: "Default" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.idle_minutes, 30);
  ids.default = r.body.id;
  r = await json(await post({ name: "Never idle", idle_minutes: 0 }));
  assert.equal(r.body.idle_minutes, 0);
  ids.never = r.body.id;
  r = await json(await admin(h.url, "POST", "/api/admin/workspace-templates", { provider: "coder", name: "Coder dev", hourly_usd: 0.2, idle_minutes: 20, config: { template: "dev" } }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.coder = r.body.id;
});

test("the setup script installs the activity agent with a per-machine token, and the agent is valid shell", async () => {
  const w = await create(sam, "agent", "default");
  const ud = aws.machines.get(w.machine_id)!.spec.userData;
  const token = tokenOf(w.machine_id);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  for (const m of ["DEVHUB_AGENT_ENV", "DEVHUB_AGENT", "DEVHUB_UNIT", "DEVHUB_TIMER"]) assert.match(ud, new RegExp(`^${m}$`, "m"));
  assert.match(ud, /umask 077\ncat > \/etc\/devhub\/agent\.env/);
  assert.match(ud, /systemctl enable --now devhub-agent\.timer/);
  // Only a hash is stored, and it never leaves the server.
  const row = await h.db.get<{ agent_token_hash: string }>("SELECT agent_token_hash FROM workspaces WHERE id = ?", w.id);
  assert.notEqual(row!.agent_token_hash, token);
  assert.equal(JSON.stringify((await json(await sam.get("/api/me/workspaces"))).body).includes(row!.agent_token_hash), false);
  assert.equal(JSON.stringify((await json(await admin(h.url, "GET", "/api/admin/workspaces"))).body).includes(row!.agent_token_hash), false);

  // Run the real agent script against this server (pointed at a temp env file instead of /etc).
  const script = /cat > \/usr\/local\/bin\/devhub-agent <<'DEVHUB_AGENT'\n([\s\S]*?)DEVHUB_AGENT\n/.exec(ud)![1];
  const dir = await mkdtemp(join(tmpdir(), "devhub-agent-"));
  await writeFile(join(dir, "agent.env"), `DEVHUB_URL=${h.url}\nDEVHUB_AGENT_TOKEN=${token}\n`);
  await writeFile(join(dir, "agent.sh"), script.replace("/etc/devhub/agent.env", join(dir, "agent.env")));
  await promisify(execFile)("sh", ["-n", join(dir, "agent.sh")]);
  await promisify(execFile)("sh", [join(dir, "agent.sh")]);
  const after = await h.sync.workspaces.get(w.id);
  assert.equal(after.last_heartbeat_at, new Date(clock).toISOString(), "the agent's heartbeat arrived and parsed");
  assert.ok((await readFile(join(dir, "agent.sh"), "utf8")).startsWith("#!/bin/sh"));
  await h.sync.workspaces.destroy(after, "test");
});

test("heartbeats need the machine's own token", async () => {
  assert.equal((await fetch(`${h.url}/api/workspaces/heartbeat`, { method: "POST" })).status, 401);
  assert.equal((await beat("not-a-real-token", { ssh: 1 })).status, 401);
  // A deleted workspace's token stops working.
  const w = await create(kim, "gone", "default");
  const token = tokenOf(w.machine_id);
  assert.equal((await beat(token, { ssh: 0 })).status, 200);
  await h.sync.workspaces.destroy(await h.sync.workspaces.get(w.id), "test");
  assert.equal((await beat(token, { ssh: 0 })).status, 401);
});

test("an idle workspace is warned, then stopped; SSH sessions and real CPU load count as use", async () => {
  const w = await create(sam, "payments", "default");
  const token = tokenOf(w.machine_id);
  aws.machines.get(w.machine_id)!.state = "running";
  await h.sync.workspaces.reconcile();
  const t0 = clock;

  // No reports yet: no idle stop, however long it's quiet (a broken agent must not cut people off).
  clock = t0 + 90 * MIN;
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 0);

  // Someone is connected over SSH.
  let r = await beat(token, { ssh: 1, load1: 0.02, cpus: 4 });
  assert.equal(await r.text(), "");
  assert.equal((await h.sync.workspaces.get(w.id)).last_active_at, new Date(clock).toISOString());

  // Disconnected, but a build keeps 2 of 4 CPUs busy: still in use.
  clock += 20 * MIN;
  await beat(token, { ssh: 0, load1: 2.1, cpus: 4 });
  assert.equal((await h.sync.workspaces.get(w.id)).last_active_at, new Date(clock).toISOString());
  const lastUse = clock;

  // Background noise (0.2 load on 4 CPUs) is not use. At 25 idle minutes the agent is told to warn.
  clock = lastUse + 10 * MIN;
  assert.equal(await (await beat(token, { ssh: 0, load1: 0.2, cpus: 4 })).text(), "");
  clock = lastUse + 25 * MIN;
  assert.match(await (await beat(token, { ssh: 0, load1: 0.2, cpus: 4 })).text(), /no activity on this workspace for a while; it stops in 5 minutes/);
  assert.equal((await h.sync.workspaces.get(w.id)).last_active_at, new Date(lastUse).toISOString());

  clock = lastUse + 29 * MIN;
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 0);
  clock = lastUse + 30 * MIN;
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 1);
  assert.ok(aws.calls.includes(`stop ${w.machine_id}`));
  const stopped = await h.sync.workspaces.get(w.id);
  assert.equal(stopped.state, "stopping");
  assert.equal(stopped.detail, "Stopped after 30 minutes without activity.");
  const a = await h.db.get<{ actor: string }>("SELECT actor FROM audit WHERE action = 'workspace.idle_stopped'");
  assert.equal(a?.actor, "system");

  // The developer sees why on their page.
  const page = await (await sam.get("/workspaces")).text();
  assert.match(page, /Stopped after 30 minutes without activity\./);

  // Starting it again gives a full idle window from the restart.
  aws.machines.get(w.machine_id)!.state = "stopped";
  await h.sync.workspaces.reconcile();
  assert.equal((await sam.post(`/api/me/workspaces/${w.id}/start`, {})).status, 200);
  aws.machines.get(w.machine_id)!.state = "running";
  clock += 29 * MIN;
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 0);
  // "Keep running" also counts as use.
  assert.equal((await sam.post(`/api/me/workspaces/${w.id}/extend`, {})).status, 200);
  clock += 29 * MIN;
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 0);
  clock += 1 * MIN;
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 1);
  aws.machines.get(w.machine_id)!.state = "stopped";
  await h.sync.workspaces.reconcile();
});

test("the agent passes on the 15-minute warning before a scheduled stop", async () => {
  const w = await create(kim, "deadline", "never");
  const token = tokenOf(w.machine_id);
  aws.machines.get(w.machine_id)!.state = "running";
  await h.sync.workspaces.reconcile();
  const ws = await h.sync.workspaces.get(w.id);
  clock = Date.parse(ws.stop_at!) - 15 * MIN;
  const warn = await (await beat(token, { ssh: 1 })).text();
  assert.match(warn, /^Dev Hub: this workspace stops in 15 minutes \(\d\d:\d\d UTC\)\. Keep it running from the Workspaces page: http/);
  clock += 1 * MIN;
  assert.equal(await (await beat(token, { ssh: 1 })).text(), "");
});

test("idle limit 0 never stops for inactivity; the schedule still applies", async () => {
  const kimId = (await getUserByEmail(h.db, "kim@acme.io"))!.id;
  const w = (await h.sync.workspaces.listFor(kimId)).find((x) => x.name === "deadline")!;
  const token = tokenOf(w.machine_id!);
  await beat(token, { ssh: 0, load1: 0 });
  clock = Date.parse(w.stop_at!) - 1 * MIN; // hours with no activity
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 0);
  clock += 1 * MIN;
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 1);
  assert.equal((await h.sync.workspaces.get(w.id)).detail, "Stopped at its scheduled time.");
});

test("a backend that tracks activity itself (Coder) drives idle stops without the agent", async () => {
  const r = await json(await sam.post("/api/me/workspaces", { template_id: ids.coder, name: "coder-one" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.machine_id as string;
  assert.equal(coder.machines.get(id)!.spec.userData, "");
  assert.equal((await h.db.get<{ h: string | null }>("SELECT agent_token_hash AS h FROM workspaces WHERE id = ?", r.body.id))!.h, null);
  coder.machines.get(id)!.state = "running";
  await h.sync.workspaces.reconcile();

  // Coder saw the developer 15 minutes in; the idle clock follows it.
  const start = clock;
  coder.seen.set(id, new Date(start + 15 * MIN).toISOString());
  clock = start + 25 * MIN;
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 0);
  assert.equal((await h.sync.workspaces.get(r.body.id)).last_active_at, new Date(start + 15 * MIN).toISOString());
  clock = start + 35 * MIN;
  assert.equal((await h.sync.workspaces.reconcile()).autoStopped, 1);
  assert.equal((await h.sync.workspaces.get(r.body.id)).detail, "Stopped after 20 minutes without activity.");
});

test("admin pages show the idle limit and last activity", async () => {
  const boss = await admin(h.url, "POST", "/api/admin/users", [{ email: "boss@acme.io", role: "admin" }]);
  assert.ok(boss.ok);
  const c = await Client.login(h.url, "boss@acme.io");
  const page = await (await c.get("/admin/workspaces")).text();
  assert.match(page, /<th>Last active<\/th>/);
  assert.match(page, /<td class="n">30 min<\/td>/);
  assert.match(page, /<td class="n">Off<\/td>/);
  const form = await (await c.get(`/admin/workspaces/templates/${ids.coder}`)).text();
  assert.match(form, /name="idle_minutes" type="number" min="0" max="480" value="20"/);
  // Saving through the form keeps it.
  const res = await c.form(`/admin/workspaces/templates/${ids.coder}`, { name: "Coder dev", provider: "coder", template: "dev", organization: "default", diskGb: "0", hourly_usd: "0.2", storage_gb_month_usd: "0.08", stop_after_hours: "8", idle_minutes: "45", enabled: "1" });
  assert.ok(res.status < 400, String(res.status));
  assert.equal((await h.sync.workspaces.templates()).find((t) => t.id === ids.coder)!.idle_minutes, 45);
});
