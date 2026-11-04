import type { Config } from "./config.js";
import { audit, getUser, getUserByEmail, insertId, isUniqueViolation, nowIso, type Db, type Param, type Queryable, type User } from "./db.js";
import { assertCanActivate, LicenseLimitError, parseAndVerify } from "./license.js";
import { HttpError } from "./service.js";
import type { SyncService } from "./sync.js";
import { usdToCents } from "./wallet.js";

/**
 * Admin operations shared by the JSON API and the portal's admin pages, so both enforce
 * the same validation, license seat limits, audit trail and Claude cap updates.
 */

export const ROLES = ["member", "manager", "admin"] as const;

export function optUsdToCents(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field} must be a non-negative number or null`);
  return usdToCents(n);
}

export function optStr(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 200) throw new HttpError(400, `${field} must be a string`);
  return v.trim();
}

export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    team_id: u.team_id,
    role: u.role,
    status: u.status,
    github_login: u.github_login,
    claude_user_id: u.claude_user_id,
    sso_linked: u.oidc_sub !== null,
    scim_managed: u.scim_external_id !== null,
    monthly_budget_usd: u.monthly_budget_cents === null ? null : u.monthly_budget_cents / 100,
  };
}

async function teamIdByName(q: Queryable, name: string | null | undefined): Promise<number | null | undefined> {
  if (name === undefined) return undefined;
  if (name === null) return null;
  const t = await q.get<{ id: number }>("SELECT id FROM teams WHERE name = ?", name);
  if (!t) throw new HttpError(400, `unknown team "${name}"`);
  return t.id;
}

/** Create or update one person by email, inside a transaction. */
async function upsertUser(q: Queryable, cfg: Config, b: Record<string, unknown>, actor: string): Promise<User> {
  const email = optStr(b.email, "email")?.toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "valid email is required");
  const role = b.role === undefined ? undefined : String(b.role);
  if (role !== undefined && !(ROLES as readonly string[]).includes(role)) {
    throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
  }
  const status = b.status === undefined ? undefined : String(b.status);
  if (status !== undefined && !["active", "disabled"].includes(status)) throw new HttpError(400, "bad status");
  const fields: Record<string, Param | undefined> = {
    name: optStr(b.name, "name"),
    team_id: await teamIdByName(q, optStr(b.team, "team")),
    role,
    status,
    github_login: optStr(b.github_login, "github_login")?.toLowerCase(),
    claude_user_id: optStr(b.claude_user_id, "claude_user_id"),
    monthly_budget_cents: optUsdToCents(b.monthly_budget_usd, "monthly_budget_usd"),
  };
  const sets = Object.entries(fields).filter((e): e is [string, Param] => e[1] !== undefined);
  let u = await getUserByEmail(q, email);
  const activating = u ? u.status === "disabled" && status === "active" : status !== "disabled";
  if (activating) {
    try {
      await assertCanActivate(q, cfg);
    } catch (e) {
      if (e instanceof LicenseLimitError) throw new HttpError(403, `${email}: ${e.message}`);
      throw e;
    }
  }
  try {
    if (!u) {
      await q.run("INSERT INTO users (email) VALUES (?)", email);
      u = (await getUserByEmail(q, email))!;
    }
    if (sets.length) {
      await q.run(`UPDATE users SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...sets.map(([, v]) => v), u.id);
    }
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, `${email}: that GitHub login or Claude user ID already belongs to someone else`);
    throw e;
  }
  if (status === "disabled") await q.run("DELETE FROM web_sessions WHERE user_id = ?", u.id);
  // Re-activating someone the IdP deleted brings them back into SCIM as well.
  if (status === "active") await q.run("UPDATE users SET deleted_at = NULL WHERE id = ?", u.id);
  await audit(q, actor, "user.saved", { email, ...Object.fromEntries(sets) });
  return (await getUser(q, u.id))!;
}

/** Create or update people (one or many) atomically, then refresh their Claude caps. */
export async function upsertUsers(
  db: Db,
  cfg: Config,
  sync: SyncService,
  list: Record<string, unknown>[],
  actor: string,
): Promise<User[]> {
  if (list.length === 0) throw new HttpError(400, "no people given");
  if (list.length > 5000) throw new HttpError(400, "at most 5000 people per call");
  const saved = await db.tx(async (q) => {
    const out: User[] = [];
    for (const b of list) out.push(await upsertUser(q, cfg, b, actor));
    return out;
  });
  // A role, status, team or budget change moves caps; push them now.
  await sync.afterChange(saved.map((u) => u.id));
  return saved;
}

export async function saveTeam(db: Db, sync: SyncService, id: number | null, b: Record<string, unknown>, actor: string) {
  const name = optStr(b.name, "name");
  const cost = optStr(b.cost_center, "cost_center");
  const pool = optUsdToCents(b.monthly_pool_usd, "monthly_pool_usd");
  const def = optUsdToCents(b.member_default_usd, "member_default_usd");
  try {
    if (id === null) {
      if (!name) throw new HttpError(400, "name is required");
      id = await insertId(
        db,
        "INSERT INTO teams (name, cost_center, monthly_pool_cents, member_default_cents) VALUES (?, ?, ?, ?)",
        name,
        cost ?? null,
        pool ?? null,
        def ?? null,
      );
    } else {
      if (!(await db.get("SELECT id FROM teams WHERE id = ?", id))) throw new HttpError(404, "team not found");
      const sets: [string, Param][] = [];
      if (name) sets.push(["name", name]);
      if (cost !== undefined) sets.push(["cost_center", cost]);
      if (pool !== undefined) sets.push(["monthly_pool_cents", pool]);
      if (def !== undefined) sets.push(["member_default_cents", def]);
      if (sets.length) {
        await db.run(`UPDATE teams SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...sets.map(([, v]) => v), id);
      }
    }
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, `a team named ${name} already exists`);
    throw e;
  }
  await audit(db, actor, "team.saved", { id, ...b });
  // Team budgets feed every member's wallet: re-check their caps.
  const members = (await db.all<{ id: number }>("SELECT id FROM users WHERE team_id = ?", id)).map((m) => m.id);
  if (members.length) await sync.afterChange(members);
  return db.get("SELECT * FROM teams WHERE id = ?", id);
}

export async function installLicense(db: Db, text: string, actor: string): Promise<void> {
  const parsed = parseAndVerify(text);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  await db.run(
    "INSERT INTO settings (key, value, updated_at) VALUES ('license', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    text,
    nowIso(),
  );
  await audit(db, actor, "license.installed", {
    id: parsed.license.id,
    seats: parsed.license.seats,
    expiresAt: parsed.license.expiresAt,
  });
}

/** Which person field identifies them to each connector, when an admin can set it by hand. */
export const LINKABLE_TOOLS: Record<string, { field: "claude_user_id" | "github_login"; label: string }> = {
  claude: { field: "claude_user_id", label: "Claude user ID" },
  copilot: { field: "github_login", label: "GitHub login" },
};

/**
 * Attach an identity that a connector reported spend for (but no one matched) to a person,
 * then re-sync so the spend lands in their wallet.
 */
export async function linkIdentity(
  db: Db,
  sync: SyncService,
  tool: string,
  externalId: string,
  userId: number,
  actor: string,
): Promise<User> {
  const link = LINKABLE_TOOLS[tool];
  if (!link) throw new HttpError(400, `${tool} spend is matched by email: add the person with that email instead`);
  const u = await getUser(db, userId);
  if (!u) throw new HttpError(404, "person not found");
  const value = link.field === "github_login" ? externalId.toLowerCase() : externalId;
  try {
    await db.run(`UPDATE users SET ${link.field} = ? WHERE id = ?`, value, u.id);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, `that ${link.label} already belongs to someone else`);
    throw e;
  }
  await audit(db, actor, "identity.linked", { tool, externalId, user: u.email });
  await sync.run();
  return (await getUser(db, u.id))!;
}

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF. Returns rows keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new HttpError(400, "CSV has an unclosed quote");
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  if (rows.length < 2) throw new HttpError(400, "CSV needs a header row and at least one person");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const allowed = ["email", "name", "team", "role", "status", "github_login", "claude_user_id", "monthly_budget_usd"];
  const unknown = header.filter((h) => !allowed.includes(h));
  if (unknown.length) throw new HttpError(400, `unknown CSV columns: ${unknown.join(", ")} (allowed: ${allowed.join(", ")})`);
  if (!header.includes("email")) throw new HttpError(400, "CSV needs an email column");
  return rows.slice(1).map((r, i) => {
    if (r.length > header.length) throw new HttpError(400, `CSV row ${i + 2} has more fields than the header`);
    const o: Record<string, string> = {};
    // An empty cell leaves that field unchanged rather than clearing it.
    header.forEach((h, j) => {
      const v = (r[j] ?? "").trim();
      if (v !== "") o[h] = v;
    });
    return o;
  });
}
