import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncService } from "../src/sync.js";
import { freshDb, harness } from "./helpers.js";

test("a rolled-back transaction never takes concurrent writes with it", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const failing = db
    .tx(async (q) => {
      await q.run("INSERT INTO teams (name) VALUES ('in-tx')");
      await gate; // stay open while another request writes
      throw new Error("boom");
    })
    .catch((e: Error) => e.message);
  const outside = db.run("INSERT INTO teams (name) VALUES ('outside')");
  setTimeout(release, 20);
  assert.equal(await failing, "boom");
  await outside;
  const names = (await db.all<{ name: string }>("SELECT name FROM teams ORDER BY name")).map((r) => r.name);
  assert.deepEqual(names, ["outside"]);
});

test("unique violations are recognized on both databases", async (t) => {
  const { db, close } = await freshDb();
  t.after(close);
  await db.run("INSERT INTO teams (name) VALUES ('x')");
  const { isUniqueViolation } = await import("../src/db.js");
  await assert.rejects(db.run("INSERT INTO teams (name) VALUES ('x')"), (e) => isUniqueViolation(e));
});

test("only one replica holds the scheduled-sync lease until it expires", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const a = new SyncService(h.db, h.cfg);
  const b = new SyncService(h.db, h.cfg);
  const now = Date.now();
  assert.equal(await a.claimSyncLease(now), true);
  assert.equal(await b.claimSyncLease(now + 1000), false);
  assert.equal(await a.claimSyncLease(now + 2000), true); // the holder renews
  const expired = now + 2000 + h.cfg.syncIntervalSeconds * 3000 + 1;
  assert.equal(await b.claimSyncLease(expired), true);
  assert.equal(await a.claimSyncLease(expired + 1), false);
});
