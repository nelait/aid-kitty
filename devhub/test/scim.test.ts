import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getUserByEmail } from "../src/db.js";
import { Client, admin, harness, type Harness } from "./helpers.js";

let h: Harness;
before(async () => {
  h = await harness({ scimToken: "scim-token" });
});
after(() => h.close());

/** Calls the SCIM API the way Okta does. */
async function scim(method: string, path: string, body?: unknown, token = "scim-token") {
  const res = await fetch(`${h.url}/scim/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json", accept: "application/scim+json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: text ? JSON.parse(text) : null };
}

const oktaUser = (email: string, given: string, family: string, externalId: string) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  userName: email,
  name: { givenName: given, familyName: family },
  emails: [{ primary: true, value: email, type: "work" }],
  displayName: `${given} ${family}`,
  externalId,
  locale: "en-US",
  groups: [],
  password: "ignored-by-dev-hub",
  active: true,
});

const ids: Record<string, string> = {};

test("SCIM requires the configured bearer token", async () => {
  assert.equal((await scim("GET", "/Users", undefined, "wrong")).status, 401);
  const off = await harness();
  try {
    const res = await fetch(`${off.url}/scim/v2/Users`, { headers: { authorization: "Bearer anything" } });
    assert.equal(res.status, 404);
  } finally {
    await off.close();
  }
});

test("discovery endpoints describe what is supported", async () => {
  const spc = await scim("GET", "/ServiceProviderConfig");
  assert.equal(spc.status, 200);
  assert.equal(spc.body.patch.supported, true);
  assert.equal(spc.body.bulk.supported, false);
  assert.match(spc.type, /application\/scim\+json/);
});

test("Okta create flow: look up by userName, then create", async () => {
  let r = await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "ana@acme.io"')}&startIndex=1&count=100`);
  assert.equal(r.status, 200);
  assert.equal(r.body.totalResults, 0);

  r = await scim("POST", "/Users", oktaUser("Ana@Acme.io", "Ana", "Silva", "00u-ana"));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.userName, "ana@acme.io");
  assert.equal(r.body.name.formatted, "Ana Silva");
  assert.equal(r.body.active, true);
  ids.ana = r.body.id;

  r = await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "ana@acme.io"')}`);
  assert.equal(r.body.totalResults, 1);
  assert.equal(r.body.Resources[0].id, ids.ana);
  r = await scim("GET", `/Users?filter=${encodeURIComponent('externalId eq "00u-ana"')}`);
  assert.equal(r.body.Resources[0].id, ids.ana);
});

test("creating a user an admin already added links that user instead of duplicating", async () => {
  await admin(h.url, "POST", "/api/admin/users", { email: "ben@acme.io", github_login: "ben-gh" });
  const existingId = String((await getUserByEmail(h.db, "ben@acme.io"))!.id);
  const r = await scim("POST", "/Users", oktaUser("ben@acme.io", "Ben", "Okafor", "00u-ben"));
  assert.equal(r.status, 201);
  assert.equal(r.body.id, existingId);
  assert.equal((await getUserByEmail(h.db, "ben@acme.io"))!.github_login, "ben-gh");
  ids.ben = r.body.id;
  // A different IdP identity can't claim the same userName.
  const dup = await scim("POST", "/Users", oktaUser("ben@acme.io", "Ben", "Other", "00u-someone-else"));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.scimType, "uniqueness");
});

test("deactivation (Okta PATCH) ends sessions and drops the Claude cap to $0; reactivation (Entra style) restores it", async () => {
  const ana = await Client.login(h.url, "ana@acme.io");
  const sub = (await getUserByEmail(h.db, "ana@acme.io"))!.oidc_sub!;
  await h.sync.pushCaps();
  assert.equal(h.claude.caps.get(sub), "10000");

  let r = await scim("PATCH", `/Users/${ids.ana}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", value: { active: false } }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.active, false);
  assert.equal((await ana.get("/api/me")).status, 401);
  assert.equal(h.claude.caps.get(sub), "0");

  r = await scim("PATCH", `/Users/${ids.ana}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "Replace", path: "active", value: "True" }],
  });
  assert.equal(r.body.active, true);
  assert.equal(h.claude.caps.get(sub), "10000");
});

test("PATCH and PUT update profile fields", async () => {
  let r = await scim("PATCH", `/Users/${ids.ana}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "name.familyName", value: "Costa" }],
  });
  assert.equal(r.body.name.formatted, "Ana Costa");
  r = await scim("PUT", `/Users/${ids.ana}`, { ...oktaUser("ana.costa@acme.io", "Ana", "Costa", "00u-ana"), id: ids.ana });
  assert.equal(r.status, 200);
  assert.equal(r.body.userName, "ana.costa@acme.io");
  // Renaming onto someone else's email is refused.
  r = await scim("PATCH", `/Users/${ids.ana}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "userName", value: "ben@acme.io" }],
  });
  assert.equal(r.status, 409);
});

test("Okta group push: groups become teams, membership sets each person's team", async () => {
  // An admin already set up "platform" with a cost center and a $50 per-person default.
  await admin(h.url, "POST", "/api/admin/teams", { name: "platform", cost_center: "CC-100", member_default_usd: 50 });

  let r = await scim("POST", "/Groups", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    displayName: "platform",
    members: [{ value: ids.ana, display: "ana.costa@acme.io" }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.platform = r.body.id;
  assert.deepEqual(r.body.members.map((m: { value: string }) => m.value), [ids.ana]);
  const team = (await h.db.get<{ cost_center: string }>("SELECT * FROM teams WHERE id = ?", Number(ids.platform)))!;
  assert.equal(team.cost_center, "CC-100");
  // Joining a team with a $50 default lowers Ana's Claude cap right away.
  const sub = (await getUserByEmail(h.db, "ana.costa@acme.io"))!.oidc_sub!;
  assert.equal(h.claude.caps.get(sub), "5000");

  r = await scim("PATCH", `/Groups/${ids.platform}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "add", path: "members", value: [{ value: ids.ben, display: "ben@acme.io" }] }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.members.length, 2);

  r = await scim("PATCH", `/Groups/${ids.platform}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "remove", path: `members[value eq "${ids.ana}"]` }],
  });
  assert.deepEqual(r.body.members.map((m: { value: string }) => m.value), [ids.ben]);
  assert.equal((await getUserByEmail(h.db, "ana.costa@acme.io"))!.team_id, null);
  assert.equal(h.claude.caps.get(sub), "10000");

  r = await scim("PATCH", `/Groups/${ids.platform}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", value: { id: ids.platform, displayName: "platform-eng" } }],
  });
  assert.equal(r.body.displayName, "platform-eng");

  r = await scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "platform-eng"')}&excludedAttributes=members`);
  assert.equal(r.body.totalResults, 1);
  assert.equal(r.body.Resources[0].members, undefined);
});

test("deleting a group removes the team but keeps its people", async () => {
  const r = await scim("DELETE", `/Groups/${ids.platform}`);
  assert.equal(r.status, 204);
  assert.equal((await scim("GET", `/Groups/${ids.platform}`)).status, 404);
  assert.equal((await getUserByEmail(h.db, "ben@acme.io"))!.team_id, null);
});

test("deleting a user hides them from SCIM but keeps them, disabled, for spend history", async () => {
  const r = await scim("DELETE", `/Users/${ids.ben}`);
  assert.equal(r.status, 204);
  assert.equal((await scim("GET", `/Users/${ids.ben}`)).status, 404);
  const ben = (await getUserByEmail(h.db, "ben@acme.io"))!;
  assert.equal(ben.status, "disabled");
  assert.ok(ben.deleted_at);
  await assert.rejects(Client.login(h.url, "ben@acme.io"), /login failed: 403/);
  // Re-provisioning later brings the same record back.
  const back = await scim("POST", "/Users", oktaUser("ben@acme.io", "Ben", "Okafor", "00u-ben"));
  assert.equal(back.status, 201);
  assert.equal(back.body.id, ids.ben);
  assert.equal(back.body.active, true);
});

test("bad requests get SCIM error bodies", async () => {
  let r = await scim("GET", `/Users?filter=${encodeURIComponent('userName co "acme"')}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.scimType, "invalidFilter");
  assert.deepEqual(r.body.schemas, ["urn:ietf:params:scim:api:messages:2.0:Error"]);
  r = await scim("POST", "/Users", { userName: "not-an-email" });
  assert.equal(r.status, 400);
  r = await scim("PATCH", `/Users/${ids.ana}`, { Operations: [] });
  assert.equal(r.status, 400);
  r = await scim("GET", "/Users/999999");
  assert.equal(r.status, 404);
});

test("paging follows startIndex and count", async () => {
  for (const n of [1, 2, 3]) await scim("POST", "/Users", oktaUser(`p${n}@acme.io`, "P", String(n), `00u-p${n}`));
  const page = await scim("GET", "/Users?startIndex=2&count=2");
  assert.equal(page.body.startIndex, 2);
  assert.equal(page.body.itemsPerPage, 2);
  assert.equal(page.body.totalResults, 5);
});
