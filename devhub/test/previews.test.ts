import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { previewSlug } from "../src/previews.js";
import { currentPeriod } from "../src/wallet.js";
import { Client, FakeCloud, admin, harness, type Harness } from "./helpers.js";

const run = promisify(execFile);
const TEMPLATE = {
  imageId: "ami-0abc12345def67890",
  instanceType: "t3.large",
  subnetId: "subnet-0abc1234",
  securityGroupIds: ["sg-0abc1234"],
  instanceProfile: "devhub-workspace",
  diskGb: 20,
};
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const SHA3 = "3".repeat(40);
const HOUR = 3_600_000;

/** Machines Dev Hub can reach on a private IP (here: this host, where the fake app listens). */
class ReachableCloud extends FakeCloud {
  privateAddress() {
    return "127.0.0.1";
  }
}

interface Pr {
  number: number;
  title: string;
  user: { login: string };
  head: { sha: string; repo: { full_name: string } };
  labels: { name: string }[];
}

/** GitHub's pulls, tarball (with the redirect to its download host) and issue-comment APIs. */
class MockGitHub {
  pulls: Pr[] = [];
  tarballs = new Map<string, Buffer>();
  comments = new Map<string, { pr: number; body: string }>();
  failPulls = false;
  url = "";
  private n = 0;
  private server: Server = createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    const send = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    let m;
    if ((m = u.pathname.match(/^\/codeload\/([0-9a-f]{40})$/))) {
      const tgz = this.tarballs.get(m[1]);
      return tgz ? res.writeHead(200, { "content-type": "application/x-gzip" }).end(tgz) : send(404, {});
    }
    if (req.headers.authorization !== "Bearer gh-token") return send(401, { message: "Bad credentials" });
    const body = await new Promise<string>((r) => {
      let s = "";
      req.on("data", (c) => (s += c)).on("end", () => r(s));
    });
    if (u.pathname === "/repos/acme/payments/pulls") {
      if (this.failPulls) return send(502, { message: "Server Error" });
      return send(200, Number(u.searchParams.get("page")) === 1 ? this.pulls : []);
    }
    if ((m = u.pathname.match(/^\/repos\/acme\/payments\/tarball\/([0-9a-f]{40})$/))) {
      return res.writeHead(302, { location: `${this.url}/codeload/${m[1]}` }).end();
    }
    if (req.method === "POST" && (m = u.pathname.match(/^\/repos\/acme\/payments\/issues\/(\d+)\/comments$/))) {
      const id = String(++this.n);
      this.comments.set(id, { pr: Number(m[1]), body: JSON.parse(body).body });
      return send(201, { id: Number(id) });
    }
    if (req.method === "PATCH" && (m = u.pathname.match(/^\/repos\/acme\/payments\/issues\/comments\/(\d+)$/))) {
      const c = this.comments.get(m[1]);
      if (!c) return send(404, { message: "Not Found" });
      c.body = JSON.parse(body).body;
      return send(200, { id: Number(m[1]) });
    }
    send(404, { message: "Not Found" });
  });
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  close() {
    this.server.closeAllConnections();
    this.server.close();
  }
  /** The comment on a PR (Dev Hub keeps one per PR, updated in place). */
  commentOn(pr: number) {
    const all = [...this.comments.values()].filter((c) => c.pr === pr);
    assert.ok(all.length <= 1, `one comment per PR, got ${all.length}`);
    return all[0]?.body ?? "";
  }
}

/** The preview app: says which build it is and echoes what Dev Hub forwarded; echoes WebSocket frames. */
class App {
  seen: IncomingMessage[] = [];
  private upgraded = new Set<import("node:stream").Duplex>();
  port = 0;
  version = "v1";
  private server = createServer((req, res) => {
    this.seen.push(req);
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "application/json", "x-app": this.version });
      res.end(JSON.stringify({ version: this.version, method: req.method, url: req.url, host: req.headers.host, email: req.headers["x-forwarded-email"], cookie: req.headers.cookie ?? null, body }));
    });
  });
  async start() {
    this.server.on("upgrade", (req, socket) => {
      this.upgraded.add(socket);
      socket.on("close", () => this.upgraded.delete(socket));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: echo\r\nconnection: Upgrade\r\nx-email: ${req.headers["x-forwarded-email"]}\r\n\r\n`);
      socket.on("data", (d) => socket.write(`echo:${d}`));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  close() {
    for (const s of this.upgraded) s.destroy();
    this.server.closeAllConnections();
    this.server.close();
  }
}

let h: Harness;
let gh: MockGitHub;
let app: App;
let cloud: ReachableCloud;
let clock = Date.parse(`${currentPeriod()}-16T09:00:00Z`);
let sam: Client;
let boss: Client;
let templateId: number;
let repoId: number;

const pr = (number: number, login: string, sha: string, extra: Partial<Pr> = {}): Pr => ({
  number,
  title: `Change ${number}`,
  user: { login },
  head: { sha, repo: { full_name: "acme/payments" } },
  labels: [],
  ...extra,
});
const svc = () => h.sync.previews;
const preview = async (n: number) => (await svc().list()).find((p) => p.pr_number === n)!;
const host = (n: number) => `${previewSlug("acme/payments", n)}.preview.test`;

/** An HTTP request to Dev Hub with a chosen Host header (fetch won't set one). */
function raw(path: string, hdrs: Record<string, string>, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
    const u = new URL(h.url);
    const req = request({ host: "127.0.0.1", port: u.port, path, method, headers: hdrs }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** A file the boot script writes, read back out of its heredoc. */
function bootFile(userData: string, path: string): string {
  const m = new RegExp(`cat > ${path.replace(/[/.]/g, "\\$&")} <<'(\\w+)'\\n([\\s\\S]*?)\\n\\1\\n`).exec(userData);
  assert.ok(m, `boot script writes ${path}`);
  return `${m[2]}\n`;
}

const machineOf = async (n: number) => {
  const p = await preview(n);
  const ws = await h.sync.workspaces.get(p.workspace_id!);
  return { p, ws, ud: cloud.machines.get(ws.machine_id!)!.spec.userData };
};
const tokenOf = (ud: string) => /^DEVHUB_AGENT_TOKEN=(.*)$/m.exec(ud)![1];

/** A source tarball like GitHub's: one top-level directory holding the repo. */
async function tarball(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "devhub-src-"));
  await mkdir(join(dir, "acme-payments-abc123"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, "acme-payments-abc123", name), content);
  await run("tar", ["-czf", join(dir, "src.tgz"), "-C", dir, "acme-payments-abc123"]);
  return readFile(join(dir, "src.tgz"));
}

/** Runs the machine's real deploy script once, with systemd and friends stubbed and /etc, /srv moved to a temp dir. */
async function deployOnce(ud: string, root: string) {
  const etc = join(root, "etc");
  const srv = join(root, "srv");
  const bin = join(root, "bin");
  await mkdir(etc, { recursive: true });
  await mkdir(join(srv, "releases"), { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const f of ["agent.env", "preview.env", "preview-build.sh"]) await writeFile(join(etc, f), bootFile(ud, `/etc/devhub/${f}`));
  await writeFile(join(root, "deploy"), bootFile(ud, "/usr/local/bin/devhub-preview-deploy"));
  for (const stub of ["systemctl", "chown", "journalctl"]) await writeFile(join(bin, stub), `#!/bin/sh\necho "${stub} $*" >> "${root}/calls"\n`);
  await writeFile(join(bin, "runuser"), `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
  for (const stub of ["systemctl", "chown", "journalctl", "runuser"]) await chmod(join(bin, stub), 0o755);
  await run("bash", [join(root, "deploy")], {
    env: { PATH: `${bin}:${process.env.PATH}`, DEVHUB_ETC: etc, DEVHUB_PREVIEW_ROOT: srv, DEVHUB_PREVIEW_WAIT: "2" },
  });
  return srv;
}

before(async () => {
  gh = await new MockGitHub().start();
  app = await new App().start();
  cloud = new ReachableCloud("aws");
  h = await harness(
    {
      connectors: { copilot: { org: "acme", token: "gh-token", apiUrl: gh.url, seatPriceUsd: { business: 19, enterprise: 39 } } },
      previews: { domain: "preview.test", webhookSecret: "whsec" },
      policyToken: "pt",
    },
    { workspaceProviders: [cloud, new FakeCloud("coder", false)], now: () => clock },
  );
  await admin(h.url, "POST", "/api/admin/users", [
    { email: "sam@acme.io", github_login: "SamDev", monthly_budget_usd: 500 },
    { email: "kim@acme.io" },
    { email: "boss@acme.io", role: "admin" },
  ]);
  sam = await Client.login(h.url, "sam@acme.io");
  boss = await Client.login(h.url, "boss@acme.io");
  const t = await admin(h.url, "POST", "/api/admin/workspace-templates", { provider: "aws", name: "Preview box", hourly_usd: 0.1, idle_minutes: 30, config: TEMPLATE, setup_script: "apt-get install -y redis-server" });
  templateId = ((await t.json()) as { id: number }).id;
});
after(async () => {
  await h.close();
  gh.close();
  app.close();
});

test("repo settings are checked: a reachable (AWS/GCP) template, a real port, a start command", async () => {
  const coder = await admin(h.url, "POST", "/api/admin/workspace-templates", { provider: "coder", name: "Coder box", hourly_usd: 0.1, config: { template: "dev" } });
  const coderId = ((await coder.json()) as { id: number }).id;
  const base = { repo: "acme/payments", template_id: templateId, port: app.port, start_command: "npm start" };
  await assert.rejects(svc().saveRepo(null, { ...base, repo: "payments" }, "t"), /owner\/name/);
  await assert.rejects(svc().saveRepo(null, { ...base, template_id: coderId }, "t"), /AWS or GCP/);
  await assert.rejects(svc().saveRepo(null, { ...base, port: 22 }, "t"), /port/);
  await assert.rejects(svc().saveRepo(null, { ...base, start_command: " " }, "t"), /start_command/);
  await assert.rejects(svc().saveRepo(null, { ...base, ttl_hours: 0 }, "t"), /ttl_hours/);
  // Through the admin form, as an admin would.
  const res = await boss.form("/admin/previews/repos/new", {
    repo: "Acme/Payments",
    template_id: String(templateId),
    port: String(app.port),
    ttl_hours: "48",
    label: "",
    allow_forks: "0",
    enabled: "1",
    build_command: "sh ./build.sh",
    start_command: "node server.js",
  });
  assert.ok(res.status < 400, String(res.status));
  const repos = await svc().repos();
  assert.equal(repos.length, 1);
  assert.equal(repos[0].repo, "acme/payments");
  repoId = repos[0].id;
  await svc().lastWebhook;
});

test("open PRs get previews; unlinked authors and forks are skipped, with a comment saying why", async () => {
  gh.pulls = [
    pr(7, "SamDev", SHA1),
    pr(8, "stranger", SHA1),
    pr(9, "SamDev", SHA1, { head: { sha: SHA1, repo: { full_name: "someone/payments" } } }),
  ];
  const r = await svc().reconcile();
  assert.deepEqual(r, { repos: 1, errors: [] });

  const p7 = await preview(7);
  assert.equal(p7.state, "active");
  assert.equal(p7.slug, "pr-7-payments");
  assert.equal(p7.email, "sam@acme.io");
  assert.equal(p7.expires_at, new Date(clock + 48 * HOUR).toISOString());
  const { ws, ud } = await machineOf(7);
  assert.equal(ws.kind, "preview");
  assert.equal(ws.idle_minutes, 0);
  assert.equal(ws.stop_at, null);
  // No SSH key needed, and it isn't one of Sam's workspaces (doesn't count toward the limit).
  assert.equal((await h.sync.workspaces.listFor(ws.user_id)).length, 0);
  assert.match(ud, /^PORT=\d+$/m);
  assert.match(ud, /^DEVHUB_PREVIEW_URL=http:\/\/pr-7-payments\.preview\.test:\d+$/m);
  assert.match(ud, /apt-get install -y redis-server/, "the template's setup script runs too");
  assert.equal(bootFile(ud, "/etc/devhub/preview-start.sh"), "exec node server.js\n");
  assert.equal(bootFile(ud, "/etc/devhub/preview-build.sh"), "set -euo pipefail\nsh ./build.sh\n");
  assert.doesNotMatch(ud, /gh-token/, "no GitHub credentials on the machine");
  await run("bash", ["-n", "-c", bootFile(ud, "/usr/local/bin/devhub-preview-deploy")]);

  assert.match(gh.commentOn(7), /^\*\*Preview environment\*\*: deploying 1111111\. It will be at http:\/\/pr-7-payments\.preview\.test:\d+/);
  assert.match(gh.commentOn(7), /counts toward @samdev's AI budget/);
  assert.equal((await preview(8)).state, "skipped");
  assert.match(gh.commentOn(8), /@stranger isn't linked to anyone in Dev Hub/);
  assert.match(gh.commentOn(9), /don't run code from forks/);

  // Nothing changed: no new comments, no new machines.
  const before = cloud.calls.length;
  await svc().reconcile();
  assert.equal(cloud.calls.length, before);
  assert.equal(gh.comments.size, 3);
});

test("the machine's deployer fetches the commit through Dev Hub, builds it and reports back", async () => {
  const { p, ud } = await machineOf(7);
  gh.tarballs.set(SHA1, await tarball({ "build.sh": "echo compiling\necho built > built.txt\n", "server.js": "" }));
  // The machine is up (the app on it is this test's App server).
  cloud.machines.get((await h.sync.workspaces.get(p.workspace_id!)).machine_id!)!.state = "running";
  await h.sync.workspaces.reconcile();
  assert.equal((await h.sync.workspaces.get(p.workspace_id!)).private_ip, "127.0.0.1");

  const root = await mkdtemp(join(tmpdir(), "devhub-preview-"));
  const srv = await deployOnce(ud.replace(/^PORT=\d+$/m, `PORT=${app.port}`), root);
  assert.equal((await readFile(join(srv, "releases", SHA1, "built.txt"), "utf8")).trim(), "built");
  assert.equal(await readlink(join(srv, "current")), join(srv, "releases", SHA1));
  assert.equal((await readFile(join(srv, "deployed"), "utf8")).trim(), SHA1);
  assert.match(await readFile(join(root, "calls"), "utf8"), /systemctl restart devhub-preview\.service/);
  let v = await preview(7);
  assert.equal(v.deploy_status, "ok");
  assert.equal(v.deploy_sha, SHA1);
  assert.match(v.deploy_log!, /compiling/);
  assert.match(gh.commentOn(7), /1111111 is live at http:\/\/pr-7-payments\.preview\.test:\d+/);

  // Same commit again: nothing to do.
  await deployOnce(ud.replace(/^PORT=\d+$/m, `PORT=${app.port}`), root);
  assert.equal((await readFile(join(root, "calls"), "utf8")).match(/restart/g)!.length, 1);

  // A push that doesn't build: reported with its output; the last good build keeps serving.
  gh.pulls[0] = pr(7, "SamDev", SHA2);
  gh.tarballs.set(SHA2, await tarball({ "build.sh": "echo boom >&2\nexit 3\n" }));
  clock += HOUR;
  await svc().reconcile();
  v = await preview(7);
  assert.equal(v.head_sha, SHA2);
  assert.equal(v.expires_at, new Date(clock + 48 * HOUR).toISOString(), "a push extends the expiry");
  await deployOnce(ud.replace(/^PORT=\d+$/m, `PORT=${app.port}`), root);
  v = await preview(7);
  assert.equal(v.deploy_status, "failed-build");
  assert.equal(v.deploy_sha, SHA1);
  assert.match(v.deploy_log!, /boom\nThe build command failed\./);
  assert.match(gh.commentOn(7), /2222222 failed to build\. The output is at http:\/\/pr-7-payments/);
  assert.doesNotMatch(gh.commentOn(7), /boom/, "build output stays behind sign-in, not on GitHub");
  assert.equal((await readlink(join(srv, "current"))), join(srv, "releases", SHA1));
});

test("the machine API only answers to that machine's token, and only for its own commit", async () => {
  const { ud } = await machineOf(7);
  const t = tokenOf(ud);
  const get = (path: string, token: string) => fetch(`${h.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get("/api/previews/target", "nope")).status, 401);
  assert.equal(await (await get("/api/previews/target", t)).text(), SHA2);
  assert.equal((await get(`/api/previews/source?sha=${SHA1}`, t)).status, 404, "not an old commit");
  assert.equal((await get(`/api/previews/source?sha=${SHA2}`, "nope")).status, 401);
  const bad = await fetch(`${h.url}/api/previews/status?sha=${SHA2}&status=hacked`, { method: "POST", headers: { authorization: `Bearer ${t}` }, body: "x" });
  assert.equal(bad.status, 400);
});

test("previews are behind Dev Hub sign-in; then requests and WebSockets reach the app with the person's email", async () => {
  // Not signed in: a page load goes to Dev Hub to sign in; anything else gets a 401.
  let r = await raw("/orders?x=1", { host: host(7), accept: "text/html" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `${h.url}/previews/auth?slug=pr-7-payments&next=%2Forders%3Fx%3D1`);
  assert.equal((await raw("/api/orders", { host: host(7), accept: "application/json" })).status, 401);

  // Dev Hub hands a short-lived token to the preview host...
  r = await raw("/previews/auth?slug=pr-7-payments&next=%2Forders%3Fx%3D1", { cookie: sam.cookie });
  assert.equal(r.status, 302);
  const handoff = new URL(r.headers.location!);
  assert.equal(handoff.host, `${host(7)}:${new URL(h.url).port}`);
  assert.equal((await raw("/previews/auth?slug=pr-7-payments", {})).headers.location, "/", "signed out: sign in first");
  // ...which turns it into its own cookie. The handoff token isn't a cookie, and is bound to its preview.
  const t = handoff.searchParams.get("t")!;
  assert.equal((await raw("/", { host: host(7), cookie: `devhub_preview=${t}`, accept: "text/html" })).status, 302);
  assert.equal((await raw(`/__devhub/auth?t=${encodeURIComponent(t)}`, { host: host(8) })).status, 403);
  r = await raw(`/__devhub/auth?t=${encodeURIComponent(t)}&next=${encodeURIComponent("/orders?x=1")}`, { host: host(7) });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "/orders?x=1");
  const cookie = String(r.headers["set-cookie"]).split(";")[0];
  assert.match(String(r.headers["set-cookie"]), /HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200/);
  assert.equal((await raw(`/__devhub/auth?t=${encodeURIComponent(t)}&next=//evil.example`, { host: host(7) })).headers.location, "/");

  // Proxied: method, path, body and status pass through; Dev Hub's cookie and any spoofed identity don't.
  r = await raw("/orders?x=1", { host: host(7), cookie: `theme=dark; ${cookie}`, "x-forwarded-email": "ceo@acme.io" }, "POST", "a=1");
  assert.equal(r.status, 200);
  const seen = JSON.parse(r.body);
  assert.deepEqual(seen, { version: "v1", method: "POST", url: "/orders?x=1", host: host(7), email: "sam@acme.io", cookie: "theme=dark", body: "a=1" });
  assert.equal(r.headers["x-app"], "v1");
  assert.equal(r.headers["content-security-policy"], undefined, "the app's own headers, not Dev Hub's");
  assert.equal((await raw("/missing", { host: host(7), cookie })).status, 404);

  // WebSocket upgrade, e.g. a dev server's live reload.
  const echoed = await new Promise<string>((resolve, reject) => {
    const s = connect(Number(new URL(h.url).port), "127.0.0.1", () => {
      s.write(`GET /ws HTTP/1.1\r\nhost: ${host(7)}\r\nconnection: Upgrade\r\nupgrade: echo\r\ncookie: ${cookie}\r\n\r\n`);
    });
    let got = "";
    s.on("data", (d) => {
      got += d;
      if (got.includes("\r\n\r\n") && !got.includes("echo:")) s.write("ping");
      if (got.includes("echo:ping")) {
        s.destroy();
        resolve(got);
      }
    });
    s.on("error", reject);
  });
  assert.match(echoed, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(echoed, /x-email: sam@acme\.io/);
  const refused = await new Promise<string>((resolve) => {
    const s = connect(Number(new URL(h.url).port), "127.0.0.1", () => s.write(`GET /ws HTTP/1.1\r\nhost: ${host(7)}\r\nconnection: Upgrade\r\nupgrade: echo\r\n\r\n`));
    let got = "";
    s.on("data", (d) => (got += d)).on("close", () => resolve(got));
  });
  assert.match(refused, /^HTTP\/1\.1 401/);

  // A deactivated person's cookie stops working.
  await admin(h.url, "POST", "/api/admin/users", [{ email: "kim@acme.io", github_login: "kimdev" }]);
  const kim = await Client.login(h.url, "kim@acme.io");
  const kh = new URL((await raw("/previews/auth?slug=pr-7-payments", { cookie: kim.cookie })).headers.location!).searchParams.get("t")!;
  const kc = String((await raw(`/__devhub/auth?t=${encodeURIComponent(kh)}`, { host: host(7) })).headers["set-cookie"]).split(";")[0];
  assert.equal((await raw("/", { host: host(7), cookie: kc })).status, 200);
  await admin(h.url, "POST", "/api/admin/users", [{ email: "kim@acme.io", status: "disabled" }]);
  assert.equal((await raw("/", { host: host(7), cookie: kc })).status, 401);
});

test("while there's nothing to serve, the preview host shows its status (and build output when it failed)", async () => {
  gh.pulls.push(pr(10, "SamDev", SHA3));
  await svc().reconcile();
  const t = new URL((await raw("/previews/auth?slug=pr-10-payments", { cookie: sam.cookie })).headers.location!).searchParams.get("t")!;
  const cookie = String((await raw(`/__devhub/auth?t=${encodeURIComponent(t)}`, { host: host(10) })).headers["set-cookie"]).split(";")[0];
  const r = await raw("/", { host: host(10), cookie });
  assert.equal(r.status, 503);
  assert.match(r.body, /Starting its machine, then deploying 3333333\./);
  assert.match(r.body, /http-equiv="refresh"/);
  assert.equal(r.headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal((await raw("/", { host: "nope.preview.test", cookie, accept: "text/html" })).status, 302, "unknown preview: still asks to sign in first");
});

test("the webhook is verified, and a closed PR's preview is removed straight away", async () => {
  const sign = (body: string, secret = "whsec") => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const hook = (body: string, event: string, sig = sign(body)) =>
    fetch(`${h.url}/api/previews/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": sig }, body });
  const body = JSON.stringify({ action: "closed", number: 10, repository: { full_name: "acme/payments" } });
  assert.equal((await hook(body, "pull_request", sign(body, "wrong"))).status, 401);
  assert.equal((await hook("{}", "ping")).status, 200);

  gh.pulls = gh.pulls.filter((x) => x.number !== 10);
  const machine = (await machineOf(10)).ws.machine_id!;
  assert.equal((await hook(body, "pull_request")).status, 202);
  await svc().lastWebhook;
  const p = await preview(10);
  assert.equal(p.state, "closed");
  assert.ok(cloud.calls.includes(`destroy ${machine}`));
  assert.match(gh.commentOn(10), /removed\. The PR was closed\./);
});

test("a failed GitHub read never removes previews", async () => {
  gh.failPulls = true;
  const r = await svc().reconcile();
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /HTTP 502/);
  assert.equal((await preview(7)).state, "active");
  gh.failPulls = false;
});

test("previews expire after the TTL without a push, and come back on the next push", async () => {
  clock += 49 * HOUR;
  await svc().reconcile();
  let p = await preview(7);
  assert.equal(p.state, "expired");
  assert.match(gh.commentOn(7), /removed\. Removed after 48 hours without a push\. Push a commit to bring it back\./);
  const oldWs = p.workspace_id;
  assert.equal((await h.sync.workspaces.get(oldWs!)).state, "terminated");

  gh.pulls[0] = pr(7, "SamDev", SHA3);
  await svc().reconcile();
  p = await preview(7);
  assert.equal(p.state, "active");
  assert.notEqual(p.workspace_id, oldWs, "a fresh machine");
  assert.equal(p.deploy_sha, null);
});

test("admins see every preview and can remove one; it stays down until the next push", async () => {
  const page = await (await boss.get("/admin/previews")).text();
  assert.match(page, /acme\/payments#7/);
  assert.match(page, /No preview: @stranger isn&#39;t linked|No preview: @stranger isn't linked/);
  assert.match(page, /\/api\/previews\/webhook/);
  const ws = await (await boss.get("/admin/workspaces")).text();
  assert.match(ws, /pv-\d+ <span class="badge">PR preview<\/span>/);
  // Sam sees the preview on their Workspaces page.
  assert.match(await (await sam.get("/workspaces")).text(), /Your pull request previews[\s\S]*acme\/payments#7/);

  const p = await preview(7);
  const res = await boss.form(`/admin/previews/${p.id}/remove`, {});
  assert.ok(res.status < 400);
  assert.equal((await preview(7)).state, "removed");
  await svc().reconcile();
  assert.equal((await preview(7)).state, "removed");
  assert.match(gh.commentOn(7), /Removed by an admin\./);
});

test("turning a repo off removes its previews; only labelled PRs when a label is set", async () => {
  gh.pulls = [pr(7, "SamDev", SHA1), pr(11, "SamDev", SHA1, { labels: [{ name: "preview" }] })];
  const r = await svc().repo(repoId);
  await svc().saveRepo(repoId, { ...r, label: "preview" }, "t");
  await svc().reconcile();
  assert.equal((await preview(11)).state, "active");
  assert.notEqual((await preview(7)).state, "active");
  await svc().saveRepo(repoId, { ...r, label: "preview", enabled: false }, "t");
  await svc().reconcile();
  const p = await preview(11);
  assert.equal(p.state, "closed");
  assert.equal(p.reason, "Previews were turned off for this repo.");
});
