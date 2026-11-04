import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import {
  claudeSettings,
  DEFAULT_ORG_POLICY,
  effective,
  EMPTY_TEAM_POLICY,
  helperScript,
  validateOrgPolicy,
  validateTeamPolicy,
} from "../src/policy.js";
import { Client, admin, harness, type Harness } from "./helpers.js";

const run = promisify(execFile);

test("the policy translates into Claude Code managed settings", () => {
  const s = claudeSettings({
    ...DEFAULT_ORG_POLICY,
    allowedModels: ["sonnet"],
    protectedPaths: ["**/.env"],
    deniedCommands: ["rm -rf *"],
    allowedMcpServers: ["github", "https://mcp.example.com/*"],
    deniedMcpServers: ["filesystem"],
    webAccess: false,
    blockBypassPermissions: true,
    extraClaudeSettings: { cleanupPeriodDays: 30 },
  });
  assert.deepEqual(s, {
    cleanupPeriodDays: 30,
    permissions: {
      deny: ["Read(**/.env)", "Edit(**/.env)", "Bash(rm -rf *)", "WebFetch", "WebSearch"],
      disableBypassPermissionsMode: "disable",
    },
    availableModels: ["sonnet"],
    enforceAvailableModels: true,
    allowedMcpServers: [{ serverName: "github" }, { serverUrl: "https://mcp.example.com/*" }],
    deniedMcpServers: [{ serverName: "filesystem" }],
  });
  // No restrictions at all → no keys that would accidentally lock things down.
  assert.deepEqual(claudeSettings({ ...DEFAULT_ORG_POLICY, protectedPaths: [], blockBypassPermissions: false }), {});
});

test("teams can only tighten the org policy", () => {
  const org = validateOrgPolicy({ allowedModels: ["sonnet", "opus"], allowedMcpServers: ["github"], webAccess: false });
  assert.throws(() => validateTeamPolicy({ allowedModels: ["fable"] }, org), /teams can only narrow/);
  assert.throws(() => validateTeamPolicy({ allowedMcpServers: ["jira"] }, org), /teams can only narrow/);
  assert.throws(() => validateTeamPolicy({ webAccess: true }, org), /can't turn it back on/);
  const t = validateTeamPolicy({ allowedModels: ["sonnet"], deniedCommands: ["git push *"] }, org);
  const e = effective(org, { name: "contractors", policy: t });
  assert.deepEqual(e.allowedModels, ["sonnet"]);
  assert.deepEqual(e.deniedCommands, ["git push *"]);
  assert.deepEqual(e.allowedMcpServers, ["github"]); // inherited
  assert.equal(e.webAccess, false);
});

test("bad entries are rejected with a clear message", () => {
  assert.throws(() => validateOrgPolicy({ allowedModels: ["Claude Opus!"] }), /isn't a model name/);
  assert.throws(() => validateOrgPolicy({ protectedPaths: ["secrets/(x)"] }), /parentheses/);
  assert.throws(() => validateOrgPolicy({ protectedPaths: ["!keep.env"] }), /negation/);
  assert.throws(() => validateOrgPolicy({ deniedMcpServers: ["not a server"] }), /isn't a server name/);
  assert.throws(() => validateOrgPolicy({ extraClaudeSettings: { permissions: {} } }), /can't set permissions/);
  assert.throws(() => validateOrgPolicy({ extraClaudeSettings: [] }), /must be a JSON object/);
});

let h: Harness;
let boss: Client;
let teamId: number;
before(async () => {
  h = await harness({ policyToken: "policy-token" });
  await admin(h.url, "POST", "/api/admin/teams", { name: "contractors" });
  await admin(h.url, "POST", "/api/admin/users", [
    { email: "boss@acme.io", role: "admin" },
    { email: "cara@acme.io", team: "contractors" },
  ]);
  teamId = (await h.db.get<{ id: number }>("SELECT id FROM teams WHERE name = 'contractors'"))!.id;
  boss = await Client.login(h.url, "boss@acme.io");
});
after(() => h.close());

test("admins edit the org policy in the portal; checkboxes and one-per-line fields map correctly", async () => {
  const r = await boss.form("/admin/policy", {
    allowedModels: "sonnet\r\nopus\r\n",
    protectedPaths: "**/.env\nsecrets/**",
    deniedCommands: "rm -rf *",
    deniedMcpServers: "",
    mcpRestricted: "1",
    allowedMcpServers: "github\nhttps://mcp.atlassian.com/*",
    webAccess: "1",
    // blockBypassPermissions unchecked
    extraClaudeSettings: '{"forceLoginMethod": "gateway"}',
  });
  assert.match(r.msg!, /Organization policy saved/);
  const api = await (await admin(h.url, "GET", "/api/admin/policy")).json();
  assert.deepEqual(api.org.allowedModels, ["sonnet", "opus"]);
  assert.deepEqual(api.org.allowedMcpServers, ["github", "https://mcp.atlassian.com/*"]);
  assert.equal(api.org.webAccess, true);
  assert.equal(api.org.blockBypassPermissions, false);
  const bad = await boss.form("/admin/policy", { extraClaudeSettings: "{nope" });
  assert.equal(bad.msg, "Extra Claude Code settings must be valid JSON.");
});

test("team rules: tightening is saved, loosening is refused, and the org can't be tightened under a team", async () => {
  let r = await boss.form(`/admin/policy/teams/${teamId}`, {
    allowedModels: "sonnet",
    protectedPaths: "",
    deniedCommands: "git push *",
    deniedMcpServers: "",
    allowedMcpServers: "",
    webAccess: "off",
  });
  assert.equal(r.msg, "Team rules saved.");
  r = await boss.form(`/admin/policy/teams/${teamId}`, { allowedModels: "fable", webAccess: "inherit" });
  assert.match(r.msg!, /teams can only narrow/);
  // Dropping "sonnet" from the org would leave the team allowing a model the org doesn't.
  r = await boss.form("/admin/policy", { allowedModels: "opus", webAccess: "1", extraClaudeSettings: "{}" });
  assert.match(r.msg!, /Team contractors's policy would loosen/);
  const page = await (await boss.get(`/admin/policy/teams/${teamId}`)).text();
  assert.match(page, /Bash\(git push \*\)/);
});

test("the policy endpoint serves each person's settings to the helper, and needs the policy token", async () => {
  assert.equal((await fetch(`${h.url}/api/policy/claude-code`)).status, 401);
  assert.equal((await fetch(`${h.url}/api/policy/claude-code`, { headers: { authorization: "Bearer test-admin-token" } })).status, 200);
  const get = (email?: string) =>
    fetch(`${h.url}/api/policy/claude-code${email ? `?email=${encodeURIComponent(email)}` : ""}`, {
      headers: { authorization: "Bearer policy-token" },
    });
  let res = await get();
  let body = await res.json();
  assert.deepEqual(Object.keys(body), ["managedSettings"]);
  assert.deepEqual(body.managedSettings.availableModels, ["sonnet", "opus"]);
  assert.equal(body.managedSettings.forceLoginMethod, "gateway");
  res = await get("Cara@Acme.io");
  assert.equal(res.headers.get("x-devhub-policy-team"), "contractors");
  body = await res.json();
  assert.deepEqual(body.managedSettings.availableModels, ["sonnet"]);
  assert.ok(body.managedSettings.permissions.deny.includes("Bash(git push *)"));
  assert.ok(body.managedSettings.permissions.deny.includes("WebFetch"));
  // Unknown email: the org policy, never anything looser.
  body = await (await get("stranger@elsewhere.io")).json();
  assert.deepEqual(body.managedSettings.availableModels, ["sonnet", "opus"]);
});

test("the gateway block matches teams by group and leaves out login-forcing keys", async () => {
  const res = await admin(h.url, "GET", "/api/admin/policy/gateway.yaml");
  const y = await res.text();
  assert.match(y, /^managed:\n {2}policies:\n {4}- match:\n {8}groups:\n {10}- "contractors"$/m);
  assert.match(y, /- match: \{\}/);
  assert.doesNotMatch(y, /forceLoginMethod/);
  assert.ok(y.indexOf('"contractors"') < y.indexOf("match: {}"), "team entries come before the catch-all");
});

test("Copilot: preview first, then apply only Dev Hub's \"*\" rule and keep per-repository rules", async () => {
  h.github.exclusions = { "octo-repo": ["/src/kernel.rs"] };
  let page = await (await boss.get("/admin/policy")).text();
  assert.match(page, /Apply to GitHub/);
  assert.equal(h.github.exclusionPuts, 0); // viewing never writes
  const r = await boss.form("/admin/policy/copilot", {});
  assert.equal(r.msg, "Copilot content exclusions updated.");
  assert.deepEqual(h.github.exclusions, { "octo-repo": ["/src/kernel.rs"], "*": ["**/.env", "**/secrets/**"] });
  const again = await boss.form("/admin/policy/copilot", {});
  assert.match(again.msg!, /nothing changed/);
  assert.equal(h.github.exclusionPuts, 1);
  page = await (await boss.get("/admin/policy")).text();
  assert.match(page, /already excludes exactly these paths/);
});

test("non-admins can't see or change policy", async () => {
  const cara = await Client.login(h.url, "cara@acme.io");
  assert.equal((await cara.get("/admin/policy")).status, 403);
  const put = await fetch(`${h.url}/api/admin/policy`, {
    method: "PUT",
    headers: { cookie: cara.cookie, "x-devhub-csrf": cara.csrf, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(put.status, 403);
  assert.equal((await cara.form("/admin/policy/copilot", {})).status, 403);
});

test("the helper script prints the policy, caches it, and survives Dev Hub being down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devhub-helper-"));
  const script = join(dir, "devhub-policy");
  writeFileSync(script, helperScript(h.cfg), { mode: 0o755 });
  const env = { PATH: process.env.PATH ?? "", HOME: dir, DEVHUB_URL: h.url, DEVHUB_POLICY_TOKEN: "policy-token", DEVHUB_USER_EMAIL: "cara@acme.io" };

  const ok = await run("sh", [script], { env });
  const out = JSON.parse(ok.stdout);
  assert.deepEqual(out.managedSettings.availableModels, ["sonnet"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".cache/devhub/claude-policy.json"), "utf8")), out);

  // Dev Hub unreachable: the cached copy keeps Claude Code working.
  const down = await run("sh", [script], { env: { ...env, DEVHUB_URL: "http://127.0.0.1:9" } });
  assert.deepEqual(JSON.parse(down.stdout), out);

  // A wrong token never overwrites the cache with an error page.
  const denied = await run("sh", [script], { env: { ...env, DEVHUB_POLICY_TOKEN: "wrong" } });
  assert.deepEqual(JSON.parse(denied.stdout), out);

  // First run with no network and no cache: fail, so Claude Code doesn't start without policy.
  const fresh = mkdtempSync(join(tmpdir(), "devhub-helper-"));
  await assert.rejects(run("sh", [script], { env: { ...env, HOME: fresh, DEVHUB_URL: "http://127.0.0.1:9" } }), /Dev Hub policy unavailable/);
});

test("empty team rules count as no team entry", () => {
  assert.deepEqual(effective(DEFAULT_ORG_POLICY, { name: "x", policy: EMPTY_TEAM_POLICY }).protectedPaths, DEFAULT_ORG_POLICY.protectedPaths);
});
