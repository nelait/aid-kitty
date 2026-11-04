import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { encodeUserData } from "../src/providers/aws.js";
import { currentPeriod } from "../src/wallet.js";
import { validateSetupScript } from "../src/workspaces.js";
import { Client, FakeCloud, admin, harness, type Harness } from "./helpers.js";

const TEMPLATE = {
  imageId: "ami-0abc12345def67890",
  instanceType: "t3.xlarge",
  subnetId: "subnet-0abc1234",
  securityGroupIds: ["sg-0abc1234"],
  instanceProfile: "devhub-workspace",
  diskGb: 20,
};
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7c2x0YWJsZWtleWZvcnRlc3RzMDAwMDAwMDAwMDAw sam@laptop";
const run = promisify(execFile);

let h: Harness;
let aws: FakeCloud;
let sam: Client;
let boss: Client;
const clock = Date.parse(`${currentPeriod()}-15T09:00:00Z`);

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const saveTemplate = (b: Record<string, unknown>) =>
  admin(h.url, "POST", "/api/admin/workspace-templates", { provider: "aws", hourly_usd: 0.2, config: TEMPLATE, ...b });

/** Pulls the template-setup section out of a machine's setup script, pointed at a temp dir instead of /var. */
async function runTemplateSection(userData: string) {
  const start = userData.indexOf("# The template's setup script");
  const end = userData.indexOf("touch /var/lib/devhub/setup-done");
  assert.ok(start > 0 && end > start, "the template section sits before setup-done");
  const dir = await mkdtemp(join(tmpdir(), "devhub-setup-"));
  const section = userData.slice(start, end).replaceAll("/var/lib/devhub", dir).replaceAll("/var/log", dir);
  await writeFile(join(dir, "run.sh"), `set -euo pipefail\n${section}`);
  await run("bash", [join(dir, "run.sh")], { env: { PATH: process.env.PATH!, OUT: join(dir, "out") } });
  return {
    dir,
    status: (await readFile(join(dir, "template-setup.status"), "utf8")).trim(),
    log: await readFile(join(dir, "devhub-template-setup.log"), "utf8"),
  };
}

before(async () => {
  aws = new FakeCloud("aws");
  h = await harness({ policyToken: "pt" }, { workspaceProviders: [aws, new FakeCloud("coder", false)], now: () => clock });
  await admin(h.url, "POST", "/api/admin/users", [
    { email: "sam@acme.io", monthly_budget_usd: 500 },
    { email: "boss@acme.io", role: "admin" },
  ]);
  sam = await Client.login(h.url, "sam@acme.io");
  boss = await Client.login(h.url, "boss@acme.io");
  const put = await fetch(`${h.url}/api/me/ssh-key`, {
    method: "PUT",
    headers: { cookie: sam.cookie, "x-devhub-csrf": sam.csrf, "content-type": "application/json" },
    body: JSON.stringify({ ssh_public_key: KEY }),
  });
  assert.equal(put.status, 200);
});
after(() => h.close());

test("setup scripts are normalised: LF endings, bash strict mode without a shebang, size and content limits", () => {
  assert.equal(validateSetupScript("  \n "), "");
  assert.equal(validateSetupScript(undefined), "");
  assert.equal(validateSetupScript("apt-get install -y jq\r\necho done\r\n"), "#!/bin/bash\nset -euo pipefail\napt-get install -y jq\necho done\n");
  assert.equal(validateSetupScript("#!/usr/bin/env python3\nprint('hi')"), "#!/usr/bin/env python3\nprint('hi')\n");
  assert.throws(() => validateSetupScript("echo a\0b"), /must be text/);
  assert.throws(() => validateSetupScript("#".repeat(40_000)), /at most 32 KB/);
});

test("a template's script runs after Dev Hub's setup; it reports success or its exit code", async () => {
  const script = [
    "#!/bin/bash",
    'echo "for $DEVHUB_USER_EMAIL on $DEVHUB_WORKSPACE_NAME as $DEVHUB_USER" > "$OUT"',
    "echo installing tools",
    // A line equal to the usual terminator must not end the heredoc early.
    "cat <<'EOF'",
    "DEVHUB_TEMPLATE_SETUP",
    "EOF",
  ].join("\n");
  let r = await json(await saveTemplate({ name: "With tools", setup_script: script }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ok = (await json(await sam.post("/api/me/workspaces", { template_id: r.body.id, name: "tools" }))).body;
  const ud = aws.machines.get(ok.machine_id)!.spec.userData;
  assert.ok(ud.indexOf("npm install -g @anthropic-ai/claude-code") < ud.indexOf("# The template's setup script"), "runs after Claude Code is installed");
  assert.match(ud, /^DEVHUB_TEMPLATE_SETUP_$/m);
  assert.match(ud, /DEVHUB_USER_EMAIL='sam@acme\.io' DEVHUB_WORKSPACE_NAME='tools' DEVHUB_USER=dev/);
  const done = await runTemplateSection(ud);
  assert.equal(done.status, "ok");
  assert.equal((await readFile(join(done.dir, "out"), "utf8")).trim(), "for sam@acme.io on tools as dev");
  assert.match(done.log, /installing tools\nDEVHUB_TEMPLATE_SETUP\n/);

  // A failing script (strict mode is added when there's no shebang) records its exit code; setup carries on.
  r = await json(await saveTemplate({ name: "Broken", setup_script: "echo starting\nfalse\necho never" }));
  const bad = (await json(await sam.post("/api/me/workspaces", { template_id: r.body.id, name: "broken" }))).body;
  const failed = await runTemplateSection(aws.machines.get(bad.machine_id)!.spec.userData);
  assert.equal(failed.status, "failed 1");
  assert.equal(failed.log, "starting\n");

  // No script, no section.
  r = await json(await saveTemplate({ name: "Plain" }));
  const plain = (await json(await sam.post("/api/me/workspaces", { template_id: r.body.id, name: "plain" }))).body;
  assert.doesNotMatch(aws.machines.get(plain.machine_id)!.spec.userData, /The template's setup script/);
});

test("the agent's setup report shows on the workspace pages", async () => {
  const w = (await h.sync.workspaces.listAll()).find((x) => x.name === "broken")!;
  aws.machines.get(w.machine_id!)!.state = "running";
  await h.sync.workspaces.reconcile();
  const token = /^DEVHUB_AGENT_TOKEN=(.*)$/m.exec(aws.machines.get(w.machine_id!)!.spec.userData)![1];
  const beat = (setup: string) =>
    fetch(`${h.url}/api/workspaces/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ssh: 1, load1: 0, cpus: 2, setup }),
    });
  await beat("running");
  assert.equal((await h.sync.workspaces.get(w.id)).setup_status, "running");
  assert.match(await (await sam.get("/workspaces")).text(), /Running the template&#39;s setup script|Running the template's setup script/);
  await beat("failed 1");
  await beat("<script>"); // junk is ignored
  assert.equal((await h.sync.workspaces.get(w.id)).setup_status, "failed 1");
  assert.match(await (await sam.get("/workspaces")).text(), /setup script failed \(exit code 1\)\. See \/var\/log\/devhub-template-setup\.log/);
  assert.match(await (await boss.get("/admin/workspaces")).text(), /Setup script failed/);
});

test("Coder templates can't take a setup script", async () => {
  const r = await json(await admin(h.url, "POST", "/api/admin/workspace-templates", { provider: "coder", name: "Coder", hourly_usd: 0.2, setup_script: "echo hi", config: { template: "dev" } }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /own templates/);
});

test("every version of a script is kept in the audit log; the admin form edits it", async () => {
  const t = (await h.sync.workspaces.templates()).find((x) => x.name === "Plain")!;
  const form = await (await boss.get(`/admin/workspaces/templates/${t.id}`)).text();
  assert.match(form, /<textarea name="setup_script"/);
  const fields = { name: "Plain", provider: "aws", imageId: TEMPLATE.imageId, instanceType: "t3.xlarge", diskGb: "20", subnetId: TEMPLATE.subnetId, securityGroupIds: "sg-0abc1234", instanceProfile: "devhub-workspace", hourly_usd: "0.2", storage_gb_month_usd: "0.08", stop_after_hours: "8", idle_minutes: "30", enabled: "1" };
  let res = await boss.form(`/admin/workspaces/templates/${t.id}`, { ...fields, setup_script: "apt-get install -y jq\r\n" });
  assert.ok(res.status < 400, String(res.status));
  assert.equal((await h.sync.workspaces.templates()).find((x) => x.id === t.id)!.setup_script, "#!/bin/bash\nset -euo pipefail\napt-get install -y jq\n");
  res = await boss.form(`/admin/workspaces/templates/${t.id}`, { ...fields, hourly_usd: "0.25", setup_script: "apt-get install -y jq" });
  assert.ok(res.status < 400);
  const saves = await h.db.all<{ detail: string }>("SELECT detail FROM audit WHERE action = 'workspace.template.saved' ORDER BY id DESC LIMIT 2");
  const [last, prev] = saves.map((s) => JSON.parse(s.detail));
  assert.equal(prev.setupScript, "#!/bin/bash\nset -euo pipefail\napt-get install -y jq\n");
  assert.equal(last.setupScript, undefined, "unchanged script isn't repeated");
  assert.equal(last.setupScriptSha256, prev.setupScriptSha256);
  assert.match(await (await boss.get("/admin/workspaces")).text(), /<td>3 lines<\/td>/);
});

test("EC2 user data over 16 KB is gzipped; too big even then is refused", () => {
  const small = "#!/bin/bash\necho hi\n";
  assert.equal(Buffer.from(encodeUserData(small), "base64").toString(), small);
  const big = `#!/bin/bash\n${"echo installing a long list of packages\n".repeat(600)}`;
  const enc = Buffer.from(encodeUserData(big), "base64");
  assert.deepEqual([...enc.subarray(0, 2)], [0x1f, 0x8b]);
  assert.equal(gunzipSync(enc).toString(), big);
  assert.throws(() => encodeUserData(randomBytes(20_000).toString("base64")), /too large/);
});
