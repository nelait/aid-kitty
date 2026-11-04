import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { CoderProvider, validateCoderTemplate } from "../src/providers/coder.js";
import { GcpProvider, validateGcpTemplate, type InstancesApi } from "../src/providers/gcp.js";
import { getUserByEmail } from "../src/db.js";
import { userData, WorkspaceService } from "../src/workspaces.js";
import { Client, FakeCloud, admin, harness, type Harness } from "./helpers.js";

const GCP_TEMPLATE = {
  zone: "us-central1-a",
  machineType: "e2-standard-4",
  image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
  subnetwork: "regions/us-central1/subnetworks/dev",
  diskGb: 80,
};

// ------------------------------------------------------------------ GCP

class FakeInstances implements InstancesApi {
  inserted: Record<string, unknown>[] = [];
  operationAwaited = false;
  calls: string[] = [];
  statuses = new Map<string, string>();
  notFound = new Set<string>();
  async insert(req: { project: string; zone: string; instanceResource: Record<string, unknown> }) {
    this.inserted.push({ ...req });
    return [{ promise: async () => (this.operationAwaited = true) }];
  }
  async start(r: { instance: string }) {
    this.calls.push(`start ${r.instance}`);
  }
  async stop(r: { instance: string }) {
    this.calls.push(`stop ${r.instance}`);
  }
  async delete(r: { instance: string }) {
    if (this.notFound.has(r.instance)) throw Object.assign(new Error("not found"), { code: 404 });
    this.calls.push(`delete ${r.instance}`);
  }
  async get(r: { zone: string; instance: string }): Promise<[{ status?: string | null }]> {
    if (this.notFound.has(r.instance)) throw Object.assign(new Error("NOT_FOUND"), { code: 5 });
    if (r.instance === "boom") throw Object.assign(new Error("permission denied"), { code: 7 });
    return [{ status: this.statuses.get(r.instance) ?? "PROVISIONING" }];
  }
}

test("GCP: a VM launches with no external IP, Shielded VM, the setup script, and safe labels", async () => {
  const api = new FakeInstances();
  const p = new GcpProvider("acme-dev", api);
  const id = await p.create(GCP_TEMPLATE, { workspaceId: 12, name: "payments", ownerEmail: "Sam.Okafor@Acme.io", userData: "#!/bin/bash\necho hi" });
  assert.equal(id, "us-central1-a/devhub-12-payments");
  assert.equal(api.operationAwaited, true, "waits for the insert operation so failures surface");
  const req = api.inserted[0] as { project: string; zone: string; instanceResource: Record<string, any> };
  assert.equal(req.project, "acme-dev");
  assert.equal(req.zone, "us-central1-a");
  const r = req.instanceResource;
  assert.equal(r.machineType, "zones/us-central1-a/machineTypes/e2-standard-4");
  assert.deepEqual(r.networkInterfaces, [{ subnetwork: "regions/us-central1/subnetworks/dev" }]); // no accessConfigs
  assert.deepEqual(r.shieldedInstanceConfig, { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true });
  assert.equal(r.disks[0].initializeParams.diskSizeGb, "80");
  assert.equal(r.disks[0].autoDelete, true);
  assert.deepEqual(r.metadata.items[0], { key: "startup-script", value: "#!/bin/bash\necho hi" });
  assert.deepEqual(r.labels, { "managed-by": "devhub", "devhub-workspace-id": "12", "devhub-owner": "sam_okafor_acme_io" });
  assert.deepEqual(r.serviceAccounts, []);
  assert.deepEqual(r.tags, { items: ["devhub-workspace"] });
});

test("GCP: TERMINATED means stopped, a missing VM is gone, other errors surface", async () => {
  const api = new FakeInstances();
  const p = new GcpProvider("acme-dev", api);
  api.statuses.set("a", "RUNNING");
  api.statuses.set("b", "TERMINATED");
  api.statuses.set("c", "STAGING");
  api.notFound.add("gone");
  const states = await p.describe(["us-central1-a/a", "us-central1-a/b", "us-central1-a/c", "us-central1-a/gone"]);
  assert.deepEqual([...states], [["us-central1-a/a", "running"], ["us-central1-a/b", "stopped"], ["us-central1-a/c", "starting"]]);
  await assert.rejects(p.describe(["us-central1-a/boom"]), /permission denied/);
  await p.destroy("us-central1-a/gone"); // already deleted: not an error
  await p.stop("us-central1-a/a");
  assert.deepEqual(api.calls, ["stop a"]);
  assert.match(p.connectHint("us-central1-a/a", "payments"), /ProxyCommand gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --project acme-dev --zone us-central1-a/);
});

test("GCP templates reject malformed values; long names stay within 63 characters", async () => {
  assert.throws(() => validateGcpTemplate({ ...GCP_TEMPLATE, zone: "us-central1" }), /zone/);
  assert.throws(() => validateGcpTemplate({ ...GCP_TEMPLATE, image: "ubuntu" }), /image/);
  assert.throws(() => validateGcpTemplate({ ...GCP_TEMPLATE, subnetwork: "dev" }), /subnetwork/);
  assert.throws(() => validateGcpTemplate({ ...GCP_TEMPLATE, serviceAccount: "me@gmail.com" }), /serviceAccount/);
  const api = new FakeInstances();
  const id = await new GcpProvider("p", api).create(GCP_TEMPLATE, { workspaceId: 123456, name: "a".repeat(32), ownerEmail: "x@y.z", userData: "" });
  const name = id.split("/")[1];
  assert.ok(name.length <= 63 && /^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(name), name);
});

// ------------------------------------------------------------------ Coder

class MockCoder {
  url = "";
  token = "coder-token";
  users = [
    { id: "u1", username: "sam", email: "Sam@Acme.io", status: "active" },
    { id: "u2", username: "kim", email: "kim@acme.io", status: "suspended" },
  ];
  created: { user: string; body: Record<string, unknown> }[] = [];
  builds: { id: string; transition: string }[] = [];
  status = new Map<string, string>();
  lastUsed = new Map<string, string>();
  private server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers["coder-session-token"] !== this.token) return send(401, { message: "You must be logged in." });
    const u = new URL(req.url!, "http://x");
    const body = await new Promise<string>((r) => {
      let s = "";
      (req as IncomingMessage).on("data", (c) => (s += c)).on("end", () => r(s));
    });
    let m;
    if (req.method === "GET" && (m = u.pathname.match(/^\/api\/v2\/organizations\/([^/]+)\/templates\/([^/]+)$/))) {
      return m[2] === "dev" ? send(200, { id: "tpl-1", name: "dev" }) : send(404, { message: `Template "${m[2]}" not found.` });
    }
    if (req.method === "GET" && u.pathname === "/api/v2/users") {
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      return send(200, { users: this.users.filter((x) => x.email.toLowerCase().includes(q) || x.username.includes(q)), count: 1 });
    }
    if (req.method === "POST" && (m = u.pathname.match(/^\/api\/v2\/users\/([^/]+)\/workspaces$/))) {
      this.created.push({ user: m[1], body: JSON.parse(body) });
      const id = `ws-${this.created.length}`;
      this.status.set(id, "starting");
      return send(201, { id, name: JSON.parse(body).name });
    }
    if (req.method === "POST" && (m = u.pathname.match(/^\/api\/v2\/workspaces\/([^/]+)\/builds$/))) {
      if (!this.status.has(m[1])) return send(404, { message: "Resource not found." });
      this.builds.push({ id: m[1], transition: JSON.parse(body).transition });
      return send(201, { status: "pending" });
    }
    if (req.method === "GET" && (m = u.pathname.match(/^\/api\/v2\/workspaces\/([^/]+)$/))) {
      if (!this.status.has(m[1])) return send(404, { message: "Resource not found." });
      return send(200, { id: m[1], latest_build: { status: this.status.get(m[1]) }, last_used_at: this.lastUsed.get(m[1]) ?? "0001-01-01T00:00:00Z" });
    }
    send(404, { message: "no route" });
  });
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  close() {
    this.server.close();
  }
}

test("Coder: creates the workspace for the person's Coder account from the named template", async () => {
  const coder = await new MockCoder().start();
  try {
    const p = new CoderProvider(coder.url, coder.token);
    const id = await p.create({ template: "dev", organization: "default" }, { workspaceId: 1, name: "payments", ownerEmail: "sam@acme.io", userData: "" });
    assert.equal(id, "ws-1");
    assert.deepEqual(coder.created, [{ user: "sam", body: { name: "payments", template_id: "tpl-1" } }]);
    await p.stop(id);
    await p.start(id);
    await p.destroy(id);
    assert.deepEqual(coder.builds.map((b) => b.transition), ["stop", "start", "delete"]);
    await p.destroy("ws-missing"); // already gone in Coder: fine
    coder.status.set("ws-1", "failed");
    coder.status.set("ws-2", "running");
    const states = await p.describe(["ws-1", "ws-2", "ws-missing"]);
    assert.deepEqual([...states], [["ws-1", "stopped"], ["ws-2", "running"]]);
    assert.match(p.connectHint(id, "payments"), /coder config-ssh[\s\S]*ssh coder\.payments/);
    // Coder's own activity tracking feeds idle detection; its "never used" zero date doesn't.
    assert.equal(p.lastActiveAt("ws-2"), undefined);
    coder.lastUsed.set("ws-2", "2026-11-04T09:12:30.123456Z");
    await p.describe(["ws-2"]);
    assert.equal(p.lastActiveAt("ws-2"), "2026-11-04T09:12:30.123Z");
  } finally {
    coder.close();
  }
});

test("Coder: clear errors for missing or suspended accounts, unknown templates and bad tokens", async () => {
  const coder = await new MockCoder().start();
  try {
    const p = new CoderProvider(coder.url, coder.token);
    const spec = (ownerEmail: string) => ({ workspaceId: 1, name: "x-ws", ownerEmail, userData: "" });
    await assert.rejects(p.create({ template: "dev" }, spec("nobody@acme.io")), /has no Coder account/);
    await assert.rejects(p.create({ template: "dev" }, spec("kim@acme.io")), /suspended/);
    await assert.rejects(p.create({ template: "nope" }, spec("sam@acme.io")), /Template "nope" not found/);
    await assert.rejects(new CoderProvider(coder.url, "wrong").describe(["ws-1"]), /HTTP 401: You must be logged in/);
    assert.throws(() => validateCoderTemplate({ template: "bad name" }), /template/);
    assert.equal(validateCoderTemplate({ template: "dev" }).organization, "default");
  } finally {
    coder.close();
  }
});

// ------------------------------------------------------------------ several backends at once

let h: Harness;
const aws = new FakeCloud("aws");
const coderCloud = new FakeCloud("coder", false);
before(async () => {
  h = await harness({ policyToken: "pt" }, { workspaceProviders: [aws, coderCloud] });
  await admin(h.url, "POST", "/api/admin/users", [{ email: "sam@acme.io" }, { email: "boss@acme.io", role: "admin" }]);
});
after(() => h.close());

test("with two backends, templates must name one that's configured", async () => {
  let r = await admin(h.url, "POST", "/api/admin/workspace-templates", { name: "Tpl", hourly_usd: 1, config: { template: "dev" } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /provider is required: one of aws, coder/);
  r = await admin(h.url, "POST", "/api/admin/workspace-templates", { name: "Tpl", provider: "gcp", hourly_usd: 1, config: GCP_TEMPLATE });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Google Compute Engine backend isn't configured/);
  r = await admin(h.url, "POST", "/api/admin/workspace-templates", { name: "Tpl", provider: "coder", hourly_usd: 1, config: { template: "bad name" } });
  assert.equal(r.status, 400);
});

test("a Coder workspace needs no SSH key and gets no setup script; each backend gets its own calls", async () => {
  const boss = await Client.login(h.url, "boss@acme.io");
  let r = await boss.form("/admin/workspaces/templates/new", { provider: "coder", name: "Coder dev", template: "dev", organization: "default", diskGb: "40", hourly_usd: "0.25", stop_after_hours: "6", enabled: "1" });
  assert.equal(r.msg, "Added template Coder dev.");
  const coderTpl = (await h.db.get<{ id: number; provider: string; config: string }>("SELECT * FROM workspace_templates WHERE name = 'Coder dev'"))!;
  assert.equal(coderTpl.provider, "coder");
  assert.deepEqual(JSON.parse(coderTpl.config), { organization: "default", template: "dev", diskGb: 40 });
  const awsTpl = await (
    await admin(h.url, "POST", "/api/admin/workspace-templates", {
      name: "EC2",
      provider: "aws",
      hourly_usd: 0.1664,
      config: { imageId: "ami-0abc12345def67890", instanceType: "t3.xlarge", subnetId: "subnet-0abc1234", securityGroupIds: ["sg-0abc1234"], instanceProfile: "p", diskGb: 50 },
    })
  ).json();

  const sam = await Client.login(h.url, "sam@acme.io");
  let created = await sam.post("/api/me/workspaces", { template_id: coderTpl.id, name: "via-coder" });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(coderCloud.machines.get("i-fake1")!.spec.userData, "");
  // The EC2 template still needs a key.
  created = await sam.post("/api/me/workspaces", { template_id: awsTpl.id, name: "via-ec2" });
  assert.equal(created.status, 400);

  // Both clouds hand out the same machine ID; reconcile keeps them apart by backend.
  await fetch(`${h.url}/api/me/ssh-key`, {
    method: "PUT",
    headers: { cookie: sam.cookie, "x-devhub-csrf": sam.csrf, "content-type": "application/json" },
    body: JSON.stringify({ ssh_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7c2x0YWJsZWtleWZvcnRlc3RzMDAwMDAwMDAwMDAw sam@laptop" }),
  });
  created = await sam.post("/api/me/workspaces", { template_id: awsTpl.id, name: "via-ec2" });
  assert.equal(created.status, 201);
  assert.ok(aws.machines.has("i-fake1") && coderCloud.machines.has("i-fake1"));
  aws.machines.get("i-fake1")!.state = "running";
  coderCloud.machines.get("i-fake1")!.state = "stopped";
  await h.sync.workspaces.reconcile();
  const mine = await h.sync.workspaces.listFor((await getUserByEmail(h.db, "sam@acme.io"))!.id);
  assert.deepEqual(Object.fromEntries(mine.map((w) => [w.name, w.state])), { "via-coder": "stopped", "via-ec2": "running" });

  const page = await (await boss.get("/admin/workspaces")).text();
  assert.match(page, /Add AWS EC2 template/);
  assert.match(page, /Add Coder template/);
  assert.match(page, /Coder template dev · 40 GB/);
  r = await boss.form(`/admin/workspaces/templates/${coderTpl.id}`, { name: "Coder dev", template: "dev2", organization: "default", diskGb: "40", hourly_usd: "0.3", stop_after_hours: "6", enabled: "1", provider: "aws" });
  assert.equal(r.msg, "Saved.");
  const after = (await h.db.get<{ provider: string; config: string }>("SELECT * FROM workspace_templates WHERE id = ?", coderTpl.id))!;
  assert.equal(after.provider, "coder", "editing never switches a template's backend");
  assert.equal(JSON.parse(after.config).template, "dev2");
});

test("if a backend is removed from the config, its workspaces are left alone, not marked deleted", async () => {
  const awsOnly = new WorkspaceService(h.db, h.cfg, [aws]);
  await awsOnly.reconcile();
  const w = (await h.db.get<{ state: string }>("SELECT state FROM workspaces WHERE name = 'via-coder'"))!;
  assert.equal(w.state, "stopped");
});

test("the setup script only runs once (GCP runs startup scripts on every boot)", async () => {
  const sam = (await getUserByEmail(h.db, "sam@acme.io"))!;
  const s = userData(h.cfg, sam, "ssh-ed25519 AAAA test");
  assert.match(s, /^\[ -f \/var\/lib\/devhub\/setup-done \] && exit 0$/m);
  assert.match(s, /touch \/var\/lib\/devhub\/setup-done\n$/);
});
