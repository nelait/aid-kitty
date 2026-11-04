import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getUserByEmail } from "../src/db.js";
import { currentPeriod, walletFor } from "../src/wallet.js";
import { harness, type Harness } from "./helpers.js";

let h: Harness;
before(async () => {
  h = await harness();
  await h.db.exec(`INSERT INTO users (email, oidc_sub, github_login) VALUES
    ('ana@acme.io', 'okta|ana', 'Ana-GH'),
    ('ben@acme.io', 'okta|ben', NULL),
    ('cy@acme.io',  'okta|cy',  'cy-gh');`);
});
after(() => h.close());

const spendOf = async (email: string, tool: string) =>
  (
    await h.db.get<{ cents: number }>(
      "SELECT cents FROM spend WHERE period = ? AND tool = ? AND user_id = ?",
      currentPeriod(),
      tool,
      (await getUserByEmail(h.db, email))!.id,
    )
  )?.cents;

test("pulls Claude and Copilot spend, matches identities, and records the rest as unmatched", async () => {
  h.claude.spend.set("okta|ana", 1234.4);
  h.claude.spend.set("okta|ben", 500);
  h.claude.spend.set("okta|ghost", 999); // not a Dev Hub user
  h.github.seats = [
    { login: "ana-gh", plan: "business" }, // case differs from stored login
    { login: "cy-gh", plan: "enterprise" },
    { login: "contractor", plan: "business" },
  ];
  const results = await h.sync.run();
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));

  assert.equal(await spendOf("ana@acme.io", "claude"), 1234);
  assert.equal(await spendOf("ben@acme.io", "claude"), 500);
  assert.equal(await spendOf("ana@acme.io", "copilot"), 1900);
  assert.equal(await spendOf("cy@acme.io", "copilot"), 3900);

  const unmatched = await h.db.all("SELECT tool, external_id, cents FROM unmatched_spend ORDER BY tool");
  assert.deepEqual(
    unmatched.map((r) => ({ ...r })),
    [
      { tool: "claude", external_id: "okta|ghost", cents: 999 },
      { tool: "copilot", external_id: "contractor", cents: 1900 },
    ],
  );
});

test("pushes a Claude cap per user equal to Claude spend plus the wallet's remainder", () => {
  // Budget 100.00. Ana: Claude 12.34 + Copilot 19.00 → 68.66 left → cap 81.00.
  assert.equal(h.claude.caps.get("okta|ana"), "8100");
  // Ben: Claude 5.00 only → cap 100.00. Cy: Copilot 39.00 → cap 61.00.
  assert.equal(h.claude.caps.get("okta|ben"), "10000");
  assert.equal(h.claude.caps.get("okta|cy"), "6100");
  // The unknown identity is never capped by us.
  assert.equal(h.claude.caps.has("okta|ghost"), false);
});

test("a second sync with no changes writes no caps", async () => {
  const before = h.claude.capWrites.length;
  await h.sync.run();
  assert.equal(h.claude.capWrites.length, before);
});

test("a vendor outage keeps the last known spend and does not touch caps", async () => {
  h.claude.fail = true;
  h.claude.spend.set("okta|ana", 0);
  const before = h.claude.capWrites.length;
  const results = await h.sync.run();
  h.claude.fail = false;
  assert.equal(results.find((r) => r.connector === "claude")!.ok, false);
  assert.match(results.find((r) => r.connector === "claude-caps")!.message, /skipped/);
  assert.equal(await spendOf("ana@acme.io", "claude"), 1234);
  assert.equal(h.claude.capWrites.length, before);
});

test("disabling a user drops their Claude cap to zero on the next sync", async () => {
  h.claude.spend.set("okta|ana", 1234.4);
  await h.db.run("UPDATE users SET status = 'disabled' WHERE email = 'ben@acme.io'");
  await h.sync.run();
  assert.equal(h.claude.caps.get("okta|ben"), "0");
  assert.equal((await walletFor(h.db, h.cfg, (await getUserByEmail(h.db, "ben@acme.io"))!)).claudeCapCents, 0);
});

test("concurrent sync calls share one run", async () => {
  const [a, b] = await Promise.all([h.sync.run(), h.sync.run()]);
  assert.equal(a, b);
});
