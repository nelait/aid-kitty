import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { AwsProvider, validateAwsTemplate } from "../src/providers/aws.js";
import { getUserByEmail } from "../src/db.js";
import { currentPeriod, walletFor } from "../src/wallet.js";
import { Client, FakeCloud, admin, harness, type Harness } from "./helpers.js";

const TEMPLATE = {
  imageId: "ami-0abc12345def67890",
  instanceType: "t3.xlarge",
  subnetId: "subnet-0abc1234",
  securityGroupIds: ["sg-0abc1234"],
  instanceProfile: "devhub-workspace",
  diskGb: 100,
};
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7c2x0YWJsZWtleWZvcnRlc3RzMDAwMDAwMDAwMDAw sam@laptop";

// ------------------------------------------------------------------ AWS provider

test("EC2: a workspace launches private, encrypted, IMDSv2-only and tagged", async () => {
  const ec2 = mockClient(EC2Client);
  ec2.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-0123456789abcdef0" }] });
  const p = new AwsProvider("us-east-1", new EC2Client({ region: "us-east-1" }));
  const id = await p.create(TEMPLATE, { workspaceId: 7, name: "payments", ownerEmail: "sam@acme.io", userData: "#!/bin/bash\necho hi" });
  assert.equal(id, "i-0123456789abcdef0");
  const input = ec2.commandCalls(RunInstancesCommand)[0].args[0].input;
  assert.equal(input.ImageId, TEMPLATE.imageId);
  assert.equal(input.InstanceType, "t3.xlarge");
  assert.deepEqual(input.NetworkInterfaces, [{ DeviceIndex: 0, SubnetId: "subnet-0abc1234", Groups: ["sg-0abc1234"], AssociatePublicIpAddress: false }]);
  assert.deepEqual(input.MetadataOptions, { HttpTokens: "required", HttpEndpoint: "enabled" });
  assert.deepEqual(input.BlockDeviceMappings![0].Ebs, { VolumeSize: 100, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true });
  assert.deepEqual(input.IamInstanceProfile, { Name: "devhub-workspace" });
  assert.equal(Buffer.from(input.UserData!, "base64").toString(), "#!/bin/bash\necho hi");
  const tags = Object.fromEntries(input.TagSpecifications![0].Tags!.map((t) => [t.Key, t.Value]));
  assert.deepEqual(tags, { Name: "devhub-payments", "devhub:workspace-id": "7", "devhub:owner": "sam@acme.io", "managed-by": "devhub" });
  ec2.restore();
});

test("EC2: states map to workspace states, and an unknown instance doesn't hide the others", async () => {
  const ec2 = mockClient(EC2Client);
  const notFound = Object.assign(new Error("The instance ID 'i-gone' does not exist"), { name: "InvalidInstanceID.NotFound" });
  ec2.on(DescribeInstancesCommand, { InstanceIds: ["i-a", "i-gone", "i-b"] }).rejects(notFound);
  ec2.on(DescribeInstancesCommand, { InstanceIds: ["i-gone"] }).rejects(notFound);
  ec2.on(DescribeInstancesCommand, { InstanceIds: ["i-a"] }).resolves({ Reservations: [{ Instances: [{ InstanceId: "i-a", State: { Name: "pending" } }] }] });
  ec2.on(DescribeInstancesCommand, { InstanceIds: ["i-b"] }).resolves({ Reservations: [{ Instances: [{ InstanceId: "i-b", State: { Name: "stopped" } }] }] });
  const p = new AwsProvider("us-east-1", new EC2Client({ region: "us-east-1" }));
  const states = await p.describe(["i-a", "i-gone", "i-b"]);
  assert.deepEqual([...states], [["i-a", "starting"], ["i-b", "stopped"]]);
  ec2.on(StopInstancesCommand).resolves({});
  await p.stop("i-a");
  assert.equal(ec2.commandCalls(StopInstancesCommand).length, 1);
  assert.match(p.connectHint("i-a", "payments"), /ProxyCommand sh -c "aws ssm start-session --region us-east-1 --target %h --document-name AWS-StartSSHSession/);
  ec2.restore();
});

test("EC2 templates reject malformed IDs", () => {
  assert.throws(() => validateAwsTemplate({ ...TEMPLATE, imageId: "ubuntu" }), /imageId/);
  assert.throws(() => validateAwsTemplate({ ...TEMPLATE, securityGroupIds: [] }), /securityGroupIds/);
  assert.throws(() => validateAwsTemplate({ ...TEMPLATE, diskGb: 4 }), /diskGb/);
  assert.deepEqual(validateAwsTemplate({ ...TEMPLATE, securityGroupIds: "sg-0abc1234, sg-0def5678" }).securityGroupIds, ["sg-0abc1234", "sg-0def5678"]);
});

// ------------------------------------------------------------------ lifecycle

let h: Harness;
let cloud: FakeCloud;
let clock = Date.parse(`${currentPeriod()}-10T09:00:00Z`);
const HOUR = 3_600_000;
let sam: Client;
let templateId: number;

before(async () => {
  cloud = new FakeCloud();
  h = await harness({ policyToken: "pt" }, { workspaceProvider: cloud, now: () => clock });
  await admin(h.url, "POST", "/api/admin/users", [
    { email: "sam@acme.io", name: "Sam", monthly_budget_usd: 100 },
    { email: "kim@acme.io" },
    { email: "boss@acme.io", role: "admin" },
  ]);
  sam = await Client.login(h.url, "sam@acme.io");
});
after(() => h.close());

const json = async (res: Response) => ({ status: res.status, body: await res.json() });

test("admins define templates; bad ones are refused", async () => {
  let r = await json(await admin(h.url, "POST", "/api/admin/workspace-templates", { name: "Standard", hourly_usd: 0.5, config: { ...TEMPLATE, imageId: "nope" } }));
  assert.equal(r.status, 400);
  r = await json(await admin(h.url, "POST", "/api/admin/workspace-templates", { name: "Standard", hourly_usd: 0.5, storage_gb_month_usd: 0.08, stop_after_hours: 4, config: TEMPLATE }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  templateId = r.body.id;
  assert.equal(r.body.hourly_usd_e4, 5000);
  r = await json(await admin(h.url, "POST", "/api/admin/workspace-templates", { name: "Standard", hourly_usd: 1, config: TEMPLATE }));
  assert.equal(r.status, 409);
  // The kind of name the admin form suggests, and a real 4-decimal cloud price.
  r = await json(await admin(h.url, "POST", "/api/admin/workspace-templates", { name: "Large (8 vCPU, 32 GB)", hourly_usd: 0.3328, enabled: false, config: TEMPLATE }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.hourly_usd_e4, 3328); // not rounded to $0.33
  r = await json(await admin(h.url, "POST", "/api/admin/workspace-templates", { name: "<script>", hourly_usd: 1, config: TEMPLATE }));
  assert.equal(r.status, 400);
});

test("a workspace needs an SSH key, then launches with the key, Claude Code and the policy helper", async () => {
  let r = await json(await sam.post("/api/me/workspaces", { template_id: templateId, name: "payments" }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /SSH public key/);
  assert.equal((await fetch(`${h.url}/api/me/ssh-key`, { method: "PUT", headers: { cookie: sam.cookie, "x-devhub-csrf": sam.csrf, "content-type": "application/json" }, body: JSON.stringify({ ssh_public_key: "not a key" }) })).status, 400);
  assert.equal((await fetch(`${h.url}/api/me/ssh-key`, { method: "PUT", headers: { cookie: sam.cookie, "x-devhub-csrf": sam.csrf, "content-type": "application/json" }, body: JSON.stringify({ ssh_public_key: KEY }) })).status, 200);

  r = await json(await sam.post("/api/me/workspaces", { template_id: templateId, name: "Bad Name!" }));
  assert.equal(r.status, 400);
  r = await json(await sam.post("/api/me/workspaces", { template_id: templateId, name: "payments" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.state, "starting");
  assert.equal(r.body.machine_id, "i-fake1");
  assert.equal(r.body.stop_at, new Date(clock + 4 * HOUR).toISOString());
  assert.match(r.body.connect, /HostName i-fake1/);

  const ud = cloud.machines.get("i-fake1")!.spec.userData;
  assert.ok(ud.includes(KEY));
  assert.match(ud, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(ud, /\/etc\/claude-code\/managed-settings\.json/);
  assert.match(ud, /"policyHelper": \{ "path": "\/usr\/local\/bin\/devhub-policy"/);
  assert.match(ud, /DEVHUB_POLICY_TOKEN=pt/);
  assert.match(ud, /DEVHUB_USER_EMAIL=sam@acme\.io/);
  // The heredocs close: every opening marker has its terminator on a line of its own.
  for (const m of ["DEVHUB_KEY", "DEVHUB_ENV", "DEVHUB_HELPER", "DEVHUB_SETTINGS"]) assert.match(ud, new RegExp(`^${m}$`, "m"));
});

test("reconcile follows the cloud, auto-stops at the deadline, and bills running hours plus disk", async () => {
  cloud.machines.get("i-fake1")!.state = "running";
  await h.sync.workspaces.reconcile();
  let w = (await h.sync.workspaces.listFor((await getUserByEmail(h.db, "sam@acme.io"))!.id))[0];
  assert.equal(w.state, "running");

  // Keep it running 2 more hours: deadline 09:00 + 4h + 2h = 15:00.
  const ext = await json(await sam.post(`/api/me/workspaces/${w.id}/extend`, {}));
  assert.equal(ext.body.stop_at, new Date(clock + 6 * HOUR).toISOString());

  clock += 6 * HOUR; // 15:00, past the deadline
  const res = await h.sync.workspaces.reconcile();
  assert.equal(res.autoStopped, 1);
  assert.ok(cloud.calls.includes("stop i-fake1"));
  cloud.machines.get("i-fake1")!.state = "stopped";
  await h.sync.workspaces.reconcile();
  w = await h.sync.workspaces.get(w.id);
  assert.equal(w.state, "stopped");

  // 6 hours at $0.50 = $3.00; disk 100 GB at $0.08/GB-month for 6 hours of a month (prorated).
  const monthHours = (Date.UTC(+currentPeriod().slice(0, 4), +currentPeriod().slice(5), 1) - Date.UTC(+currentPeriod().slice(0, 4), +currentPeriod().slice(5) - 1, 1)) / HOUR;
  const expected = Math.round(300 + (6 / monthHours) * 100 * 8);
  const costs = await h.sync.workspaces.monthlyCosts(currentPeriod());
  assert.equal(costs.get(w.user_id), expected);

  // The sync puts it in the wallet as its own tool.
  await h.sync.run();
  const wallet = await walletFor(h.db, h.cfg, (await getUserByEmail(h.db, "sam@acme.io"))!);
  assert.equal(wallet.spendByTool.workspaces, expected);
});

test("keeping a workspace running is capped at 12 hours from now", async () => {
  const w = (await h.sync.workspaces.listFor((await getUserByEmail(h.db, "sam@acme.io"))!.id))[0];
  await json(await sam.post(`/api/me/workspaces/${w.id}/start`, {}));
  for (let i = 0; i < 10; i++) await sam.post(`/api/me/workspaces/${w.id}/extend`, {});
  const after = await h.sync.workspaces.get(w.id);
  assert.equal(after.stop_at, new Date(clock + 12 * HOUR).toISOString());
  await sam.post(`/api/me/workspaces/${w.id}/stop`, {});
  cloud.machines.get("i-fake1")!.state = "stopped";
  await h.sync.workspaces.reconcile();
});

test("people can only touch their own workspaces; admins can stop or delete any", async () => {
  const w = (await h.sync.workspaces.listFor((await getUserByEmail(h.db, "sam@acme.io"))!.id))[0];
  const kim = await Client.login(h.url, "kim@acme.io");
  assert.equal((await kim.post(`/api/me/workspaces/${w.id}/start`, {})).status, 404);
  assert.equal((await kim.post(`/api/me/workspaces/${w.id}/delete`, {})).status, 404);
  assert.equal((await kim.get("/admin/workspaces")).status, 403);
  const list = await json(await admin(h.url, "GET", "/api/admin/workspaces"));
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].email, "sam@acme.io");
});

test("no starting or creating once the budget is used up", async () => {
  await admin(h.url, "POST", "/api/admin/spend-import", { tool: "codex", rows: [{ email: "sam@acme.io", usd: 100 }] });
  const w = (await h.sync.workspaces.listFor((await getUserByEmail(h.db, "sam@acme.io"))!.id))[0];
  let r = await json(await sam.post(`/api/me/workspaces/${w.id}/start`, {}));
  assert.equal(r.status, 402);
  assert.match(r.body.error, /budget for this month is used up/);
  r = await json(await sam.post("/api/me/workspaces", { template_id: templateId, name: "second" }));
  assert.equal(r.status, 402);
  await admin(h.url, "POST", "/api/admin/spend-import", { tool: "codex", rows: [] });
});

test("a cloud failure on create is reported and leaves no half-made workspace running", async () => {
  cloud.failCreate = "InsufficientInstanceCapacity";
  const r = await json(await sam.post("/api/me/workspaces", { template_id: templateId, name: "flaky" }));
  cloud.failCreate = null;
  assert.equal(r.status, 502);
  assert.match(r.body.error, /InsufficientInstanceCapacity/);
  const failed = await h.db.get<{ state: string }>("SELECT state FROM workspaces WHERE name = 'flaky'");
  assert.equal(failed?.state, "error");
  const mine = await json(await sam.get("/api/me/workspaces"));
  assert.ok(!mine.body.workspaces.some((w: { name: string; state: string }) => w.name === "flaky" && w.state !== "error"));
});

test("the limit on workspaces per person", async () => {
  await sam.post("/api/me/workspaces", { template_id: templateId, name: "two" });
  // "flaky" (failed) still counts as a slot until deleted; three in total is the default limit.
  const r = await json(await sam.post("/api/me/workspaces", { template_id: templateId, name: "four" }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /up to 3 workspaces/);
});

test("portal: create, confirm before delete, then delete terminates the machine", async () => {
  const page = await (await sam.get("/workspaces")).text();
  assert.match(page, /payments/);
  assert.match(page, /Connect with VS Code or SSH/);
  const w = (await h.sync.workspaces.listFor((await getUserByEmail(h.db, "sam@acme.io"))!.id)).find((x) => x.name === "payments")!;
  const confirm = await (await sam.get(`/workspaces/${w.id}/delete`)).text();
  assert.match(confirm, /deletes its disk/);
  const r = await sam.form(`/workspaces/${w.id}/delete`, {});
  assert.equal(r.msg, "Deleted payments.");
  assert.ok(cloud.calls.includes("destroy i-fake1"));
  assert.equal((await h.sync.workspaces.get(w.id)).state, "terminated");
  const boss = await Client.login(h.url, "boss@acme.io");
  assert.match(await (await boss.get("/admin/workspaces")).text(), /Templates/);
});
