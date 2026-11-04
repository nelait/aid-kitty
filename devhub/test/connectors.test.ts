import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CopilotConnector } from "../src/connectors/copilot.js";
import { CursorConnector } from "../src/connectors/cursor.js";
import { getUserByEmail } from "../src/db.js";
import { currentPeriod } from "../src/wallet.js";
import { harness, MockCursor, MockGitHub, type Harness } from "./helpers.js";

let h: Harness;
before(async () => {
  h = await harness();
  h.db.exec(`INSERT INTO users (email, oidc_sub, github_login) VALUES
    ('Ana@Acme.io', 'okta|ana', 'ana-gh'),
    ('ben@acme.io', 'okta|ben', 'ben-gh');`);
});
after(() => h.close());

const spendOf = (email: string, tool: string) =>
  (
    h.db
      .prepare("SELECT cents FROM spend WHERE period = ? AND tool = ? AND user_id = ?")
      .get(currentPeriod(), tool, getUserByEmail(h.db, email)!.id) as { cents: number } | undefined
  )?.cents;

test("Copilot spend = seat price + premium-request overage (Copilot products only, net of allowance)", async () => {
  h.github.seats = [
    { login: "ana-gh", plan: "business" },
    { login: "ben-gh", plan: "business" },
  ];
  h.github.premium.set("ana-gh", [
    { product: "Copilot", netAmount: 3.2 },
    { product: "Copilot", netAmount: 0 }, // fully covered by the included allowance
    { product: "Actions", netAmount: 9 }, // not Copilot
  ]);
  const results = await h.sync.run();
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(spendOf("ana@acme.io", "copilot"), 1900 + 320);
  assert.equal(spendOf("ben@acme.io", "copilot"), 1900);
  assert.equal(h.github.premiumCalls, 2);
  // The overage reduces Claude headroom: 100.00 - 22.20 = 77.80.
  assert.equal(h.claude.caps.get("okta|ana"), "7780");
});

test("premium usage is cached between syncs to stay inside GitHub's rate limits", async () => {
  await h.sync.run();
  assert.equal(h.github.premiumCalls, 2);
});

test("premium usage refreshes after the configured interval", async () => {
  const gh = await new MockGitHub().start();
  try {
    gh.seats = [{ login: "ana-gh", plan: "enterprise" }];
    gh.premium.set("ana-gh", [{ product: "Copilot", netAmount: 1 }]);
    let now = Date.UTC(2026, 10, 4, 12);
    const c = new CopilotConnector(
      { org: "acme", token: "gh-token", apiUrl: gh.url, seatPriceUsd: { business: 19, enterprise: 39 }, premiumRefreshMinutes: 30 },
      () => now,
    );
    const total = async () => (await c.fetchMonthlySpend()).reduce((a, r) => a + r.cents, 0);
    assert.equal(await total(), 3900 + 100);
    gh.premium.set("ana-gh", [{ product: "Copilot", netAmount: 5 }]);
    now += 29 * 60_000;
    assert.equal(await total(), 3900 + 100);
    now += 2 * 60_000;
    assert.equal(await total(), 3900 + 500);
    assert.equal(gh.premiumCalls, 2);
  } finally {
    gh.close();
  }
});

test("Cursor spend is matched by email, case-insensitively, across pages", async () => {
  h.cursor.members = [
    { email: "ana@acme.io", spendCents: 1250 },
    { email: "BEN@ACME.IO", spendCents: 400 },
    { email: "intern@acme.io", spendCents: 75 },
  ];
  const results = await h.sync.run();
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(spendOf("ana@acme.io", "cursor"), 1250);
  assert.equal(spendOf("ben@acme.io", "cursor"), 400);
  const unmatched = h.db.prepare("SELECT external_id, cents FROM unmatched_spend WHERE tool = 'cursor'").all();
  assert.deepEqual(unmatched.map((r) => ({ ...r })), [{ external_id: "intern@acme.io", cents: 75 }]);
  // Ana: Copilot 22.20 + Cursor 12.50 → 65.30 left; Claude cap 65.30.
  assert.equal(h.claude.caps.get("okta|ana"), "6530");
});

test("an unexpected Cursor response fails the pull instead of recording wrong numbers", async () => {
  const bad = new MockCursor();
  await bad.start();
  try {
    bad.members = [{ email: "ana@acme.io", spendCents: "12" as unknown as number }];
    const c = new CursorConnector({ apiKey: "cursor-key", apiUrl: bad.url });
    await assert.rejects(c.fetchMonthlySpend(), /without email\/spendCents/);
    await assert.rejects(new CursorConnector({ apiKey: "wrong", apiUrl: bad.url }).fetchMonthlySpend(), /HTTP 401/);
  } finally {
    bad.close();
  }
});
