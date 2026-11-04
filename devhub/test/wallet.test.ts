import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.js";
import { getUserByEmail } from "../src/db.js";
import { currentPeriod, walletFor } from "../src/wallet.js";
import { freshDb } from "./helpers.js";

async function setup(t: TestContext) {
  const cfg = loadConfig({
    databasePath: ":memory:",
    wallet: { defaultMonthlyBudgetUsd: 100, warnAt: 0.8 },
    connectors: {},
  });
  const store = await freshDb();
  t.after(() => store.close());
  const db = store.db;
  const period = currentPeriod();
  const addSpend = async (email: string, tool: string, cents: number) =>
    db.run(
      "INSERT INTO spend (period, user_id, tool, cents, synced_at) VALUES (?, ?, ?, ?, 'now')",
      period,
      (await getUserByEmail(db, email))!.id,
      tool,
      cents,
    );
  return { cfg, db, period, addSpend };
}

test("budget resolves user override, then team default, then org default", async (t) => {
  const { cfg, db } = await setup(t);
  await db.exec(`INSERT INTO teams (id, name, member_default_cents) VALUES (1, 'web', 25000);
           INSERT INTO users (email, team_id) VALUES ('a@x.io', 1), ('b@x.io', NULL);
           INSERT INTO users (email, team_id, monthly_budget_cents) VALUES ('c@x.io', 1, 5000);`);
  assert.equal((await walletFor(db, cfg, (await getUserByEmail(db, "a@x.io"))!)).limitCents, 25000);
  assert.equal((await walletFor(db, cfg, (await getUserByEmail(db, "b@x.io"))!)).limitCents, 10000);
  assert.equal((await walletFor(db, cfg, (await getUserByEmail(db, "c@x.io"))!)).limitCents, 5000);
});

test("Claude cap leaves room only for what other tools have not used", async (t) => {
  const { cfg, db, addSpend } = await setup(t);
  await db.exec(`INSERT INTO users (email) VALUES ('a@x.io')`);
  await addSpend("a@x.io", "copilot", 1900);
  await addSpend("a@x.io", "claude", 3000);
  const w = (await walletFor(db, cfg, (await getUserByEmail(db, "a@x.io"))!));
  assert.equal(w.spendCents, 4900);
  assert.equal(w.remainingCents, 5100);
  // Claude may grow from 30.00 to 81.00, which brings the total to exactly 100.00.
  assert.equal(w.claudeCapCents, 8100);
  assert.equal(w.state, "ok");
});

test("approved raises for this period add to the limit; others do not", async (t) => {
  const { cfg, db, period } = await setup(t);
  await db.exec(`INSERT INTO users (id, email) VALUES (1, 'a@x.io')`);
  const ins = (p: string, cents: number, status: string) =>
    db.run("INSERT INTO raise_requests (user_id, period, amount_cents, reason, status) VALUES (1, ?, ?, 'r', ?)", p, cents, status);
  await ins(period, 2000, "approved");
  await ins(period, 9000, "pending");
  await ins(period, 9000, "denied");
  await ins("2000-01", 9000, "approved");
  assert.equal((await walletFor(db, cfg, (await getUserByEmail(db, "a@x.io"))!)).limitCents, 12000);
});

test("a team pool clamps everyone in the team once it runs out", async (t) => {
  const { cfg, db, addSpend } = await setup(t);
  await db.exec(`INSERT INTO teams (id, name, monthly_pool_cents) VALUES (1, 'data', 15000);
           INSERT INTO users (email, team_id) VALUES ('a@x.io', 1), ('b@x.io', 1);`);
  await addSpend("a@x.io", "claude", 9000);
  await addSpend("b@x.io", "claude", 4000);
  const b = (await walletFor(db, cfg, (await getUserByEmail(db, "b@x.io"))!));
  // b personally has 60.00 left, but the team only has 20.00 left.
  assert.equal(b.remainingCents, 2000);
  assert.equal(b.claudeCapCents, 6000);
  await addSpend("a@x.io", "copilot", 3000);
  const b2 = (await walletFor(db, cfg, (await getUserByEmail(db, "b@x.io"))!));
  assert.equal(b2.remainingCents, 0);
  assert.equal(b2.claudeCapCents, 4000);
  assert.equal(b2.state, "exhausted");
});

test("overspent wallets never produce a negative remainder; disabled users get a zero cap", async (t) => {
  const { cfg, db, addSpend } = await setup(t);
  await db.exec(`INSERT INTO users (email) VALUES ('a@x.io');
           INSERT INTO users (email, status) VALUES ('gone@x.io', 'disabled');`);
  await addSpend("a@x.io", "claude", 12000);
  const a = (await walletFor(db, cfg, (await getUserByEmail(db, "a@x.io"))!));
  assert.equal(a.remainingCents, 0);
  assert.equal(a.claudeCapCents, 12000);
  const gone = (await walletFor(db, cfg, (await getUserByEmail(db, "gone@x.io"))!));
  assert.equal(gone.claudeCapCents, 0);
  assert.equal(gone.limitCents, 0);
});

test("warning state starts at the configured utilization", async (t) => {
  const { cfg, db, addSpend } = await setup(t);
  await db.exec(`INSERT INTO users (email) VALUES ('a@x.io')`);
  await addSpend("a@x.io", "claude", 8000);
  assert.equal((await walletFor(db, cfg, (await getUserByEmail(db, "a@x.io"))!)).state, "warning");
});
