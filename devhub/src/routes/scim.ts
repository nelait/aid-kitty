import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "../config.js";
import { audit, getUser, insertId, nowIso, type Db, type Param, type Queryable, type Team, type User } from "../db.js";
import { assertCanActivate, LicenseLimitError } from "../license.js";
import type { SyncService } from "../sync.js";

/**
 * SCIM 2.0 (RFC 7643/7644) provisioning endpoint for Okta and other IdPs, at /scim/v2.
 *
 * - Users: userName is the email. Deactivating (active=false) or deleting a user disables
 *   them, ends their sessions and pushes a $0 Claude cap. Deleted users are kept, hidden
 *   from SCIM, so spend history and chargeback stay intact.
 * - Groups map to Dev Hub teams. A person belongs to one team, so adding them to a second
 *   pushed group moves them.
 */

const SCHEMA = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  list: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  patch: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
};

class ScimError extends Error {
  constructor(
    public status: number,
    message: string,
    public scimType?: string,
  ) {
    super(message);
  }
}

const CT = "application/scim+json";
const send = (res: Response, status: number, body: unknown) => res.status(status).type(CT).send(JSON.stringify(body));

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

/** Supports the filters Okta and Entra send: `attr eq "value"`. */
function parseFilter(filter: unknown, allowed: Record<string, string>): { column: string; value: string } | null {
  if (filter === undefined || filter === "") return null;
  const m = String(filter).match(/^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i);
  const column = m ? allowed[m[1].toLowerCase()] : undefined;
  if (!m || !column) throw new ScimError(400, `unsupported filter: ${String(filter).slice(0, 100)}`, "invalidFilter");
  return { column, value: m[2].replace(/\\(.)/g, "$1") };
}

function paging(req: Request) {
  const startIndex = Math.max(1, Number(req.query.startIndex) || 1);
  const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100) || 0));
  return { startIndex, count };
}

function splitName(full: string | null) {
  if (!full) return {};
  const parts = full.trim().split(/\s+/);
  return { formatted: full, givenName: parts[0], familyName: parts.length > 1 ? parts.slice(1).join(" ") : undefined };
}

export function scimRoutes(db: Db, cfg: Config, sync: SyncService) {
  const r = express.Router();
  const base = () => `${cfg.publicUrl}/scim/v2`;

  r.use((req, res, next) => {
    const token = cfg.scimToken;
    const sent = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
    const ok = !!token && sent.length === token.length && timingSafeEqual(Buffer.from(sent), Buffer.from(token));
    if (!token) return send(res, 404, { schemas: [SCHEMA.error], status: "404", detail: "SCIM is not enabled" });
    if (!ok) return send(res, 401, { schemas: [SCHEMA.error], status: "401", detail: "bad SCIM token" });
    next();
  });
  r.use(express.json({ type: ["application/json", CT], limit: "1mb" }));

  // ---------- representation ----------
  const userResource = async (u: User) => {
    const team = u.team_id !== null ? await db.get<{ id: number; name: string }>("SELECT id, name FROM teams WHERE id = ?", u.team_id) : undefined;
    return {
      schemas: [SCHEMA.user],
      id: String(u.id),
      externalId: u.scim_external_id ?? undefined,
      userName: u.email,
      name: splitName(u.name),
      displayName: u.name ?? undefined,
      emails: [{ value: u.email, type: "work", primary: true }],
      active: u.status === "active",
      groups: team ? [{ value: String(team.id), display: team.name, $ref: `${base()}/Groups/${team.id}` }] : [],
      meta: { resourceType: "User", created: u.created_at, location: `${base()}/Users/${u.id}` },
    };
  };

  const groupResource = async (t: Team, withMembers = true) => ({
    schemas: [SCHEMA.group],
    id: String(t.id),
    externalId: t.scim_external_id ?? undefined,
    displayName: t.name,
    members: withMembers
      ? (await db.all<{ id: number; email: string }>("SELECT id, email FROM users WHERE team_id = ? AND deleted_at IS NULL ORDER BY id", t.id)).map(
          (m) => ({ value: String(m.id), display: m.email, $ref: `${base()}/Users/${m.id}` }),
        )
      : undefined,
    meta: { resourceType: "Group", location: `${base()}/Groups/${t.id}` },
  });

  const liveUser = async (q: Queryable, id: string): Promise<User> => {
    const u = /^\d+$/.test(id) ? await getUser(q, Number(id)) : undefined;
    if (!u || u.deleted_at) throw new ScimError(404, `User ${id} not found`);
    return u;
  };
  const team = async (id: string): Promise<Team> => {
    const t = /^\d+$/.test(id) ? await db.get<Team>("SELECT * FROM teams WHERE id = ?", Number(id)) : undefined;
    if (!t) throw new ScimError(404, `Group ${id} not found`);
    return t;
  };
  const memberIdsOf = async (teamId: number) =>
    (await db.all<{ id: number }>("SELECT id FROM users WHERE team_id = ?", teamId)).map((x) => String(x.id));

  // ---------- user writes ----------
  interface UserFields {
    email?: string;
    name?: string | null;
    active?: boolean;
    externalId?: string | null;
  }

  /** Pull the fields Dev Hub keeps out of a SCIM User body (POST/PUT). */
  function userFields(body: Record<string, any>): UserFields {
    const primaryEmail =
      (Array.isArray(body.emails) ? (body.emails.find((e: any) => e?.primary) ?? body.emails[0]) : undefined)?.value;
    const email = String(EMAIL_RE.test(String(body.userName ?? "")) ? body.userName : (primaryEmail ?? "")).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ScimError(400, "userName or a primary email must be an email address", "invalidValue");
    const n = body.name ?? {};
    const name = n.formatted ?? ([n.givenName, n.familyName].filter(Boolean).join(" ") || body.displayName || null);
    return { email, name, active: body.active === undefined ? true : toBool(body.active), externalId: body.externalId ?? null };
  }

  function toBool(v: unknown): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "string" && /^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
    throw new ScimError(400, "active must be a boolean", "invalidValue");
  }

  const checkSeat = async (q: Queryable) => {
    try {
      await assertCanActivate(q, cfg);
    } catch (e) {
      if (e instanceof LicenseLimitError) throw new ScimError(403, e.message);
      throw e;
    }
  };

  /** Apply fields to a user; returns whether their status changed (which moves caps). */
  async function applyUser(q: Queryable, u: User, f: UserFields): Promise<boolean> {
    const sets: [string, Param][] = [];
    if (f.email !== undefined && f.email !== u.email) {
      const other = await q.get("SELECT id FROM users WHERE email = ? AND id != ?", f.email, u.id);
      if (other) throw new ScimError(409, `userName ${f.email} is already taken`, "uniqueness");
      sets.push(["email", f.email]);
    }
    if (f.name !== undefined && f.name !== u.name) sets.push(["name", f.name]);
    if (f.externalId !== undefined && f.externalId !== u.scim_external_id) sets.push(["scim_external_id", f.externalId]);
    const status = f.active === undefined ? u.status : f.active ? "active" : "disabled";
    if (status === "active" && (u.status !== "active" || u.deleted_at)) await checkSeat(q);
    if (status !== u.status) sets.push(["status", status]);
    if (sets.length) {
      await q.run(`UPDATE users SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...sets.map(([, v]) => v), u.id);
      await audit(q, "scim", "scim.user.updated", { id: u.id, ...Object.fromEntries(sets) });
    }
    if (status === "disabled") await q.run("DELETE FROM web_sessions WHERE user_id = ?", u.id);
    return status !== u.status;
  }

  const afterStatusChange = async (userId: number) => {
    await sync.afterChange([userId]);
  };

  // ---------- discovery ----------
  r.get("/ServiceProviderConfig", (_req, res) =>
    send(res, 200, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "Static bearer token" }],
    }),
  );
  r.get("/ResourceTypes", (_req, res) =>
    send(res, 200, {
      schemas: [SCHEMA.list],
      totalResults: 2,
      Resources: [
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: SCHEMA.user },
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: SCHEMA.group },
      ],
    }),
  );

  // ---------- Users ----------
  r.get(
    "/Users",
    wrap(async (req, res) => {
      const f = parseFilter(req.query.filter, { username: "email", externalid: "scim_external_id", "emails.value": "email" });
      const { startIndex, count } = paging(req);
      const where = `deleted_at IS NULL${f ? ` AND ${f.column} = ?` : ""}`;
      const args = f ? [f.column === "email" ? f.value.toLowerCase() : f.value] : [];
      const total = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE ${where}`, ...args))!.n);
      const rows = await db.all<User>(`SELECT * FROM users WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`, ...args, count, startIndex - 1);
      const resources = [];
      for (const u of rows) resources.push(await userResource(u));
      send(res, 200, { schemas: [SCHEMA.list], totalResults: total, startIndex, itemsPerPage: rows.length, Resources: resources });
    }),
  );

  r.get("/Users/:id", wrap(async (req, res) => send(res, 200, await userResource(await liveUser(db, req.params.id)))));

  r.post(
    "/Users",
    wrap(async (req, res) => {
      const f = userFields(req.body ?? {});
      const user = await db.tx(async (q) => {
        const existing = await q.get<User>("SELECT * FROM users WHERE email = ?", f.email!);
        if (existing && !existing.deleted_at && existing.scim_external_id && existing.scim_external_id !== f.externalId) {
          throw new ScimError(409, `userName ${f.email} already exists`, "uniqueness");
        }
        if (existing) {
          // Adopt a user an admin created by hand, or bring back one the IdP deleted earlier.
          await applyUser(q, existing, f);
          await q.run("UPDATE users SET deleted_at = NULL WHERE id = ?", existing.id);
          await audit(q, "scim", "scim.user.linked", { id: existing.id, email: existing.email });
          return (await getUser(q, existing.id))!;
        }
        if (f.active !== false) await checkSeat(q);
        const id = await insertId(
          q,
          "INSERT INTO users (email, name, status, scim_external_id) VALUES (?, ?, ?, ?)",
          f.email!,
          f.name ?? null,
          f.active === false ? "disabled" : "active",
          f.externalId ?? null,
        );
        await audit(q, "scim", "scim.user.created", { id, email: f.email });
        return (await getUser(q, id))!;
      });
      await afterStatusChange(user.id);
      send(res, 201, await userResource(user));
    }),
  );

  r.put(
    "/Users/:id",
    wrap(async (req, res) => {
      const f = userFields(req.body ?? {});
      const { id, changed } = await db.tx(async (q) => {
        const u = await liveUser(q, req.params.id);
        return { id: u.id, changed: await applyUser(q, u, f) };
      });
      if (changed) await afterStatusChange(id);
      send(res, 200, await userResource((await getUser(db, id))!));
    }),
  );

  r.patch(
    "/Users/:id",
    wrap(async (req, res) => {
      const ops = patchOps(req.body);
      const { id, changed } = await db.tx(async (q) => {
        const u = await liveUser(q, req.params.id);
        const f: UserFields = {};
        for (const op of ops) {
          if (op.op === "remove") throw new ScimError(400, "remove is not supported on Users", "mutability");
          // Okta sends {op, value: {active: false}}; Entra sends {op, path: "active", value: "False"}.
          const entries: [string, unknown][] = op.path ? [[op.path, op.value]] : Object.entries(op.value ?? {});
          for (const [rawPath, value] of entries) {
            const path = rawPath.toLowerCase();
            if (path === "active") f.active = toBool(value);
            else if (path === "username" || /^emails(\[.*\])?(\.value)?$/.test(path)) {
              const v = Array.isArray(value) ? (value.find((e: any) => e?.primary) ?? value[0])?.value : value;
              const email = String(v ?? "").toLowerCase();
              if (!EMAIL_RE.test(email)) throw new ScimError(400, "userName must be an email address", "invalidValue");
              f.email = email;
            } else if (path === "externalid") f.externalId = value == null ? null : String(value);
            else if (path === "displayname" || path === "name.formatted") f.name = value == null ? null : String(value);
            else if (path === "name.givenname" || path === "name.familyname" || path === "name") {
              const cur = splitName(f.name ?? u.name);
              const n = path === "name" ? ((value as any) ?? {}) : { [path === "name.givenname" ? "givenName" : "familyName"]: value };
              f.name = [n.givenName ?? cur.givenName, n.familyName ?? cur.familyName].filter(Boolean).join(" ") || null;
            }
            // Other attributes (title, phone numbers, enterprise extension) are accepted and ignored.
          }
        }
        return { id: u.id, changed: await applyUser(q, u, f) };
      });
      if (changed) await afterStatusChange(id);
      send(res, 200, await userResource((await getUser(db, id))!));
    }),
  );

  r.delete(
    "/Users/:id",
    wrap(async (req, res) => {
      const u = await liveUser(db, req.params.id);
      await db.tx(async (q) => {
        await q.run("UPDATE users SET status = 'disabled', deleted_at = ? WHERE id = ?", nowIso(), u.id);
        await q.run("DELETE FROM web_sessions WHERE user_id = ?", u.id);
        await audit(q, "scim", "scim.user.deleted", { id: u.id, email: u.email });
      });
      await afterStatusChange(u.id);
      res.status(204).end();
    }),
  );

  // ---------- Groups (= teams) ----------
  const setMembers = async (q: Queryable, t: Team, ids: string[], mode: "add" | "remove" | "replace") => {
    const users: User[] = [];
    for (const id of ids) users.push(await liveUser(q, id));
    if (mode === "replace") await q.run("UPDATE users SET team_id = NULL WHERE team_id = ?", t.id);
    for (const u of users) {
      if (mode === "remove") await q.run("UPDATE users SET team_id = NULL WHERE id = ? AND team_id = ?", u.id, t.id);
      else await q.run("UPDATE users SET team_id = ? WHERE id = ?", t.id, u.id);
    }
    await audit(q, "scim", `scim.group.members.${mode}`, { team: t.name, users: users.map((u) => u.email) });
  };

  const memberIds = (v: unknown): string[] =>
    (Array.isArray(v) ? v : v ? [v] : []).map((m: any) => {
      if (m?.value === undefined) throw new ScimError(400, "member entries need a value", "invalidValue");
      return String(m.value);
    });

  const renameTeam = async (q: Queryable, t: Team, name: unknown) => {
    const n = String(name ?? "").trim();
    if (!n) throw new ScimError(400, "displayName is required", "invalidValue");
    if (n === t.name) return;
    if (await q.get("SELECT id FROM teams WHERE name = ? AND id != ?", n, t.id)) {
      throw new ScimError(409, `a team named ${n} already exists`, "uniqueness");
    }
    await q.run("UPDATE teams SET name = ? WHERE id = ?", n, t.id);
    await audit(q, "scim", "scim.group.renamed", { id: t.id, from: t.name, to: n });
  };

  // A team change can move someone into or out of a team pool; re-check caps for everyone affected.
  const pushTeamCaps = async (teamId: number, extra: string[] = []) => {
    const ids = [...(await memberIdsOf(teamId)), ...extra].map(Number);
    await sync.afterChange([...new Set(ids)]);
  };

  r.get(
    "/Groups",
    wrap(async (req, res) => {
      const f = parseFilter(req.query.filter, { displayname: "name", externalid: "scim_external_id" });
      const { startIndex, count } = paging(req);
      const where = f ? `WHERE ${f.column} = ?` : "";
      const args = f ? [f.value] : [];
      const total = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM teams ${where}`, ...args))!.n);
      const rows = await db.all<Team>(`SELECT * FROM teams ${where} ORDER BY id LIMIT ? OFFSET ?`, ...args, count, startIndex - 1);
      const withMembers = !/members/.test(String(req.query.excludedAttributes ?? ""));
      const resources = [];
      for (const t of rows) resources.push(await groupResource(t, withMembers));
      send(res, 200, { schemas: [SCHEMA.list], totalResults: total, startIndex, itemsPerPage: rows.length, Resources: resources });
    }),
  );

  r.get("/Groups/:id", wrap(async (req, res) => send(res, 200, await groupResource(await team(req.params.id)))));

  r.post(
    "/Groups",
    wrap(async (req, res) => {
      const name = String(req.body?.displayName ?? "").trim();
      if (!name) throw new ScimError(400, "displayName is required", "invalidValue");
      const ids = memberIds(req.body.members);
      const teamId = await db.tx(async (q) => {
        let t = await q.get<Team>("SELECT * FROM teams WHERE name = ?", name);
        if (t?.scim_external_id && req.body.externalId && t.scim_external_id !== req.body.externalId) {
          throw new ScimError(409, `group ${name} already exists`, "uniqueness");
        }
        if (t) {
          // Link a team an admin created by hand (keeps its cost center and budgets).
          await q.run("UPDATE teams SET scim_external_id = ? WHERE id = ?", req.body.externalId ?? null, t.id);
        } else {
          const id = await insertId(q, "INSERT INTO teams (name, scim_external_id) VALUES (?, ?)", name, req.body.externalId ?? null);
          t = (await q.get<Team>("SELECT * FROM teams WHERE id = ?", id))!;
        }
        await audit(q, "scim", "scim.group.created", { id: t.id, name });
        if (ids.length) await setMembers(q, t, ids, "add");
        return t.id;
      });
      await pushTeamCaps(teamId);
      send(res, 201, await groupResource(await team(String(teamId))));
    }),
  );

  r.put(
    "/Groups/:id",
    wrap(async (req, res) => {
      const t = await team(req.params.id);
      const before = await memberIdsOf(t.id);
      await db.tx(async (q) => {
        await renameTeam(q, t, req.body?.displayName);
        if (req.body?.members !== undefined) await setMembers(q, t, memberIds(req.body.members), "replace");
      });
      await pushTeamCaps(t.id, before);
      send(res, 200, await groupResource(await team(req.params.id)));
    }),
  );

  r.patch(
    "/Groups/:id",
    wrap(async (req, res) => {
      const t = await team(req.params.id);
      const ops = patchOps(req.body);
      const touched = await memberIdsOf(t.id);
      await db.tx(async (q) => {
        for (const op of ops) {
          const path = (op.path ?? "").toLowerCase();
          if (op.op === "remove" && path.startsWith("members")) {
            // Okta: path `members[value eq "42"]`; others: path `members` + value list.
            const m = op.path!.match(/^members\[value eq "([^"]+)"\]$/i);
            const ids = m ? [m[1]] : memberIds(op.value);
            if (!ids.length) await q.run("UPDATE users SET team_id = NULL WHERE team_id = ?", t.id);
            else {
              await setMembers(q, t, ids, "remove");
              touched.push(...ids);
            }
          } else if ((op.op === "add" || op.op === "replace") && path === "members") {
            const ids = memberIds(op.value);
            await setMembers(q, t, ids, op.op);
            touched.push(...ids);
          } else if (op.op !== "remove" && (path === "displayname" || path === "")) {
            const v = path === "" ? (op.value as any)?.displayName : op.value;
            if (v !== undefined) await renameTeam(q, (await q.get<Team>("SELECT * FROM teams WHERE id = ?", t.id))!, v);
            if (path === "" && (op.value as any)?.members !== undefined) {
              const ids = memberIds((op.value as any).members);
              await setMembers(q, t, ids, op.op === "add" ? "add" : "replace");
              touched.push(...ids);
            }
          } else if (path === "externalid") {
            await q.run("UPDATE teams SET scim_external_id = ? WHERE id = ?", op.op === "remove" ? null : String(op.value), t.id);
          } else {
            throw new ScimError(400, `unsupported PATCH ${op.op} ${op.path ?? ""}`, "invalidPath");
          }
        }
      });
      await pushTeamCaps(t.id, touched);
      // Okta accepts 204; returning the group helps other IdPs.
      send(res, 200, await groupResource(await team(req.params.id)));
    }),
  );

  r.delete(
    "/Groups/:id",
    wrap(async (req, res) => {
      const t = await team(req.params.id);
      const members = (await memberIdsOf(t.id)).map(Number);
      await db.tx(async (q) => {
        await q.run("UPDATE users SET team_id = NULL WHERE team_id = ?", t.id);
        await q.run("DELETE FROM teams WHERE id = ?", t.id);
        await audit(q, "scim", "scim.group.deleted", { id: t.id, name: t.name, members: members.length });
      });
      await sync.afterChange(members);
      res.status(204).end();
    }),
  );

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ScimError) {
      return send(res, err.status, { schemas: [SCHEMA.error], status: String(err.status), scimType: err.scimType, detail: err.message });
    }
    if (err instanceof SyntaxError) return send(res, 400, { schemas: [SCHEMA.error], status: "400", scimType: "invalidSyntax", detail: "invalid JSON" });
    console.error(err);
    send(res, 500, { schemas: [SCHEMA.error], status: "500", detail: "internal error" });
  });

  return r;
}

interface PatchOp {
  op: "add" | "remove" | "replace";
  path?: string;
  value?: unknown;
}

function patchOps(body: any): PatchOp[] {
  const ops = body?.Operations;
  if (!Array.isArray(ops) || ops.length === 0) throw new ScimError(400, "Operations must be a non-empty array", "invalidSyntax");
  return ops.map((o: any) => {
    const op = String(o?.op ?? "").toLowerCase();
    if (!["add", "remove", "replace"].includes(op)) throw new ScimError(400, `unknown op ${o?.op}`, "invalidSyntax");
    return { op: op as PatchOp["op"], path: typeof o.path === "string" ? o.path : undefined, value: o.value };
  });
}
