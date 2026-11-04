import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, licenseStatus, parseAndVerify } from "../src/license.js";
import { getUserByEmail } from "../src/db.js";
import { Client, admin, harness, testLicense } from "./helpers.js";

const addUsers = (url: string, emails: string[]) =>
  admin(url, "POST", "/api/admin/users", emails.map((email) => ({ email })));

test("canonical JSON ignores key order, so signatures survive re-serialization", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } }), canonicalJson({ a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 }));
  const file = JSON.parse(testLicense(10));
  const reordered = JSON.stringify({ signature: file.signature, license: Object.fromEntries(Object.entries(file.license).reverse()) });
  assert.equal(parseAndVerify(reordered).ok, true);
});

test("tampering with any field breaks the signature", () => {
  const file = JSON.parse(testLicense(10));
  file.license.seats = 10000;
  const r = parseAndVerify(JSON.stringify(file));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /signature/);
  assert.equal(parseAndVerify("not json").ok, false);
});

test("without a license, evaluation mode allows 5 active people", async () => {
  const h = await harness({ license: {} });
  try {
    assert.equal((await addUsers(h.url, ["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io"])).status, 201);
    const res = await addUsers(h.url, ["f@x.io"]);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /seat limit/);
    // Sign-in can't create a sixth person either.
    await assert.rejects(Client.login(h.url, "g@x.io"), /login failed: 403/);
    // Existing people still sign in.
    await Client.login(h.url, "a@x.io");
    const status = (await licenseStatus(h.db, h.cfg));
    assert.equal(status.state, "evaluation");
    assert.equal(status.canActivate, false);
  } finally {
    await h.close();
  }
});

test("a 10-seat license allows 11 (10% true-up, at least one); freeing a seat allows the next person", async () => {
  const h = await harness({ license: { text: testLicense(10) }, scimToken: "scim-token" });
  try {
    const emails = Array.from({ length: 11 }, (_, i) => `u${i}@x.io`);
    assert.equal((await addUsers(h.url, emails)).status, 201);
    assert.equal((await addUsers(h.url, ["late@x.io"])).status, 403);
    // A bulk import that would cross the limit is rolled back as a whole.
    assert.equal(await getUserByEmail(h.db, "late@x.io"), undefined);

    const scim = await fetch(`${h.url}/scim/v2/Users`, {
      method: "POST",
      headers: { authorization: "Bearer scim-token", "content-type": "application/scim+json" },
      body: JSON.stringify({ userName: "okta@x.io", active: true }),
    });
    assert.equal(scim.status, 403);

    await admin(h.url, "POST", "/api/admin/users", { email: "u0@x.io", status: "disabled" });
    assert.equal((await addUsers(h.url, ["late@x.io"])).status, 201);
    // Reactivating u0 now needs a seat too.
    assert.equal((await admin(h.url, "POST", "/api/admin/users", { email: "u0@x.io", status: "active" })).status, 403);
  } finally {
    await h.close();
  }
});

test("expiry: 30-day grace, then no new people, but budgets keep being enforced", async () => {
  const h = await harness({ license: { text: testLicense(50, -10) } });
  try {
    let s = (await licenseStatus(h.db, h.cfg));
    assert.equal(s.state, "grace");
    assert.equal(s.canActivate, true);
    assert.match(s.message, /Renew within 20 days/);

    const later = Date.now() + 25 * 86_400_000;
    s = (await licenseStatus(h.db, h.cfg, later));
    assert.equal(s.state, "expired");
    assert.equal(s.canActivate, false);
  } finally {
    await h.close();
  }

  const expired = await harness({ license: { text: testLicense(50, -40) } });
  try {
    await expired.db.exec(`INSERT INTO users (email, oidc_sub) VALUES ('ana@x.io', 'okta|ana')`);
    assert.equal((await addUsers(expired.url, ["new@x.io"])).status, 403);
    expired.claude.spend.set("okta|ana", 2500);
    const results = await expired.sync.run();
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    assert.equal(expired.claude.caps.get("okta|ana"), "10000");
  } finally {
    await expired.close();
  }
});

test("admins can install a license through the API; bad files are refused", async () => {
  const h = await harness({ license: {} });
  try {
    assert.equal((await admin(h.url, "GET", "/api/admin/license").then((r) => r.json())).state, "evaluation");
    const tampered = JSON.parse(testLicense(25));
    tampered.license.customer = "Someone else";
    let res = await admin(h.url, "PUT", "/api/admin/license", { license_file: tampered });
    assert.equal(res.status, 400);
    res = await admin(h.url, "PUT", "/api/admin/license", { license_file: testLicense(25, 365, "Globex") });
    assert.equal(res.status, 200);
    const status = await res.json();
    assert.equal(status.state, "valid");
    assert.equal(status.customer, "Globex");
    assert.equal(status.seatLimit, 27);
    const dev = await Client.login(h.url, "dev@x.io");
    assert.equal((await dev.get("/api/admin/license")).status, 403);
  } finally {
    await h.close();
  }
});
