import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { GrantedLicense } from "@aws-sdk/client-license-manager";
import { assertCanActivate, licenseStatus } from "../src/license.js";
import { AWS_MARKETPLACE_FINGERPRINT, marketplaceState, type LicenseManagerApi } from "../src/marketplace.js";
import { Client, admin, harness, type Harness } from "./helpers.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** AWS License Manager as the buyer's account sees it. */
class FakeLicenseManager implements LicenseManagerApi {
  licenses: GrantedLicense[] = [];
  checkouts: { sku: string; entitlement: string; count: number }[] = [];
  fail: Error | null = null;
  async listReceived(sku: string) {
    if (this.fail) throw this.fail;
    return this.licenses.filter((l) => l.ProductSKU === sku);
  }
  async checkout(sku: string, entitlement: string, count: number) {
    if (this.fail) throw this.fail;
    this.checkouts.push({ sku, entitlement, count });
    return { allowed: count };
  }
}

const license = (seats: number, over: Partial<GrantedLicense> = {}): GrantedLicense => ({
  LicenseArn: "arn:aws:license-manager::294406891311:license:l-1",
  ProductSKU: "sku-devhub",
  Issuer: { Name: "AWS/Marketplace", KeyFingerprint: AWS_MARKETPLACE_FINGERPRINT },
  Status: "AVAILABLE",
  Beneficiary: "arn:aws:iam::123456789012:root",
  Validity: { Begin: "2026-11-01T00:00:00Z", End: "2027-11-01T00:00:00Z" },
  Entitlements: [{ Name: "Users", Unit: "Count", MaxCount: seats }],
  ...over,
});
const named = (name: string) => Object.assign(new Error(name), { name });

const harnesses: Harness[] = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

test("AWS Marketplace: seats come from the buyer's License Manager license, checked out on each sync", async () => {
  let clock = Date.parse("2026-11-04T10:00:00Z");
  const lm = new FakeLicenseManager();
  const h = await harness({ marketplace: { aws: { productSku: "sku-devhub" } }, license: {} }, { licenseManager: lm, now: () => clock });
  harnesses.push(h);
  await admin(h.url, "POST", "/api/admin/users", [{ email: "a@acme.io" }, { email: "b@acme.io" }, { email: "boss@acme.io", role: "admin" }]);

  // Before the first check: evaluation limits.
  let s = await licenseStatus(h.db, h.cfg, clock);
  assert.equal(s.state, "evaluation");
  assert.equal(s.source, "aws-marketplace");
  assert.match(s.message, /Checking AWS Marketplace/);

  // A license from someone else (not AWS Marketplace's issuer) doesn't count.
  lm.licenses = [license(50, { Issuer: { Name: "Someone", KeyFingerprint: "aws:111:Someone:fp" } })];
  let r = await h.sync.run();
  assert.deepEqual(r.find((x) => x.connector === "aws-marketplace")?.ok, false);
  s = await licenseStatus(h.db, h.cfg, clock);
  assert.equal(s.state, "invalid");
  assert.equal(s.seatLimit, 5);
  assert.match(s.message, /No active AWS Marketplace license for product sku-devhub/);

  lm.licenses = [license(25), license(10, { LicenseArn: "older" })];
  r = await h.sync.run();
  assert.deepEqual(r.find((x) => x.connector === "aws-marketplace"), { connector: "aws-marketplace", ok: true, message: "25 people purchased" });
  s = await licenseStatus(h.db, h.cfg, clock);
  assert.equal(s.state, "valid");
  assert.equal(s.seats, 25);
  assert.equal(s.seatLimit, 27);
  assert.equal(s.customer, "AWS account root");
  assert.equal(s.expiresAt, "2027-11-01T00:00:00Z");
  assert.match(s.message, /25 people purchased through AWS Marketplace until 2027-11-01/);
  // The checkout asks for what's in use, within what's bought.
  assert.deepEqual(lm.checkouts.at(-1), { sku: "sku-devhub", entitlement: "Users", count: 3 });

  // The admin page says where it's from and offers no license-file upload.
  const boss = await Client.login(h.url, "boss@acme.io");
  const page = await (await boss.get("/admin/license")).text();
  assert.match(page, /Bought through<\/th><td>AWS Marketplace/);
  assert.doesNotMatch(page, /Install a license/);

  // A check that can't reach AWS keeps the last good result for 30 days.
  lm.fail = named("ThrottlingException");
  clock += 10 * DAY;
  await h.sync.run();
  s = await licenseStatus(h.db, h.cfg, clock);
  assert.equal(s.state, "grace");
  assert.equal(s.seats, 25);
  assert.equal(s.canActivate, true);
  assert.match(s.message, /Couldn't check the AWS Marketplace license: ThrottlingException.*Using the last good check for 20 more days/);
  clock += 21 * DAY;
  await h.sync.run();
  s = await licenseStatus(h.db, h.cfg, clock);
  assert.equal(s.state, "expired");
  assert.equal(s.canActivate, false);

  // Back again; then the subscription is cancelled: AWS refuses the checkout. No grace for that.
  lm.fail = null;
  await h.sync.run();
  assert.equal((await licenseStatus(h.db, h.cfg, clock)).state, "valid");
  lm.fail = named("NoEntitlementsAllowedException");
  await h.sync.run();
  s = await licenseStatus(h.db, h.cfg, clock);
  assert.equal(s.state, "expired");
  assert.match(s.message, /isn't entitled \(NoEntitlementsAllowedException\).*Existing people and budget enforcement keep working/);
  await assert.rejects(assertCanActivate(h.db, h.cfg), /expired|entitled/);
  const audits = await h.db.all<{ action: string }>("SELECT action FROM audit WHERE action LIKE 'marketplace.%' ORDER BY id");
  assert.ok(audits.length >= 4 && audits.length <= 8, `state changes are audited, not every check (${audits.length})`);
});

/** Google's metering agent (ubbagent): records reports, reports a configurable status. */
class FakeAgent {
  reports: { name: string; startTime: string; endTime: string; value: { int64Value: number } }[] = [];
  failures = 0;
  down = false;
  url = "";
  private server: Server = createServer((req, res) => {
    if (this.down) return void res.writeHead(503).end("down");
    if (req.method === "POST" && req.url === "/report") {
      let b = "";
      req.on("data", (c) => (b += c)).on("end", () => {
        this.reports.push(JSON.parse(b));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
    if (req.url === "/status") {
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ lastReportSuccess: "2026-11-04T09:00:00Z", currentFailureCount: this.failures, totalFailureCount: this.failures }));
    }
    res.writeHead(404).end();
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
}

test("Google Cloud Marketplace: active people are reported for each hour, exactly once, with no seat limit", async () => {
  const agent = await new FakeAgent().start();
  let clock = Date.parse("2026-11-04T10:30:00Z");
  const h = await harness({ marketplace: { gcp: { agentUrl: agent.url } }, license: {} }, { now: () => clock });
  harnesses.push(h);
  try {
    // More people than evaluation allows: metered billing has no seat limit.
    await admin(h.url, "POST", "/api/admin/users", [{ email: "a@acme.io" }, { email: "b@acme.io" }, { email: "c@acme.io" }]);
    await h.sync.run();
    const people = Number((await h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"))!.n);
    assert.deepEqual(agent.reports, [{ name: "active_users", startTime: "2026-11-04T09:00:00.000Z", endTime: "2026-11-04T10:00:00.000Z", value: { int64Value: people } }]);
    let s = await licenseStatus(h.db, h.cfg, clock);
    assert.equal(s.state, "valid");
    assert.equal(s.metered, true);
    assert.equal(s.canActivate, true);
    assert.match(s.message, /Billed through Google Cloud Marketplace for each active person, every hour/);
    await admin(h.url, "POST", "/api/admin/users", [1, 2, 3, 4, 5, 6].map((i) => ({ email: `p${i}@acme.io` })));
    assert.equal(Number((await h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"))!.n), people + 6);

    // Same hour again: nothing new. Three hours later: three contiguous hours, never overlapping.
    await h.sync.run();
    assert.equal(agent.reports.length, 1);
    clock += 3 * HOUR;
    await Promise.all([h.sync.marketplace.tick(), h.sync.marketplace.tick()]); // two at once still bill each hour once
    assert.deepEqual(
      agent.reports.map((r) => r.startTime.slice(11, 16)),
      ["09:00", "10:00", "11:00", "12:00"],
    );
    assert.equal(agent.reports.at(-1)!.value.int64Value, people + 6);

    // The agent can't reach Google: a warning, then after 30 days no new people.
    agent.failures = 4;
    clock += HOUR;
    await h.sync.run();
    s = await licenseStatus(h.db, h.cfg, clock);
    assert.equal(s.state, "grace");
    assert.match(s.message, /can't reach Google \(4 failed reports in a row/);
    // Then the agent is unreachable for a month: no new people; nothing reported, nothing lost.
    agent.failures = 0;
    agent.down = true;
    const before = agent.reports.length;
    clock += 31 * DAY;
    await h.sync.marketplace.tick();
    s = await licenseStatus(h.db, h.cfg, clock);
    assert.equal(s.state, "expired");
    assert.equal(s.canActivate, false);
    assert.match(s.message, /Couldn't report usage to the metering agent: the metering agent refused the report: HTTP 503/);
    assert.equal(agent.reports.length, before);

    // Back: the claimed hour was released, and reports catch up at most a day.
    agent.down = false;
    await h.sync.marketplace.tick();
    assert.equal(agent.reports.length - before, 24);
    const hours = agent.reports.slice(before).map((r) => Date.parse(r.startTime));
    assert.ok(hours.every((t, i) => i === 0 || t - hours[i - 1] === HOUR), "contiguous");
    assert.equal((await licenseStatus(h.db, h.cfg, clock)).state, "valid");
    assert.equal((await marketplaceState(h.db))!.reportedThrough, new Date(Math.floor(clock / HOUR) * HOUR).toISOString());
  } finally {
    agent.close();
  }
});
