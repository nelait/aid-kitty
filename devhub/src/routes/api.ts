import express, { type NextFunction, type Request, type Response } from "express";
import { requireAdmin, requireUser } from "../auth.js";
import type { Config } from "../config.js";
import { audit, getUser, getUserByEmail, insertId, isUniqueViolation, nowIso, type Db, type Param, type Queryable, type User } from "../db.js";
import {
  HttpError,
  createRaiseRequest,
  decideRaiseRequest,
  listDecidable,
  reportCsv,
  spendReport,
} from "../service.js";
import { assertCanActivate, LicenseLimitError, licenseStatus, parseAndVerify } from "../license.js";
import type { SyncService } from "../sync.js";
import { currentPeriod, usdToCents, walletFor } from "../wallet.js";

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TOOL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function optUsdToCents(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field} must be a non-negative number or null`);
  return usdToCents(n);
}

function optStr(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 200) throw new HttpError(400, `${field} must be a string`);
  return v.trim();
}

function publicUser(u: User) {
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
    monthly_budget_usd: u.monthly_budget_cents === null ? null : u.monthly_budget_cents / 100,
  };
}

export function apiRoutes(db: Db, cfg: Config, sync: SyncService) {
  const r = express.Router();
  r.use(express.json({ limit: "1mb" }));

  // ---- Self-service ----
  r.get(
    "/me",
    requireUser,
    wrap(async (req, res) => {
      const u = req.principal!.user;
      if (!u) throw new HttpError(400, "the automation token has no wallet");
      res.json({ user: publicUser(u), wallet: await walletFor(db, cfg, u), csrf: req.principal!.csrf });
    }),
  );

  r.get(
    "/me/raise-requests",
    requireUser,
    wrap(async (req, res) => {
      const u = req.principal!.user;
      if (!u) throw new HttpError(400, "the automation token has no wallet");
      res.json(await db.all("SELECT * FROM raise_requests WHERE user_id = ? ORDER BY id DESC", u.id));
    }),
  );

  r.post(
    "/me/raise-requests",
    requireUser,
    wrap(async (req, res) => {
      const u = req.principal!.user;
      if (!u) throw new HttpError(400, "the automation token has no wallet");
      res.status(201).json(await createRaiseRequest(db, cfg, u, Number(req.body.amount_usd), String(req.body.reason ?? "")));
    }),
  );

  // ---- Approvals (managers for their team, admins for everyone) ----
  r.get(
    "/raise-requests",
    requireUser,
    wrap(async (req, res) => {
      const status = String(req.query.status ?? "pending");
      if (!["pending", "approved", "denied"].includes(status)) throw new HttpError(400, "bad status");
      res.json(await listDecidable(db, req.principal!, status));
    }),
  );

  for (const action of ["approve", "deny"] as const) {
    r.post(
      `/raise-requests/:id/${action}`,
      requireUser,
      wrap(async (req, res) => {
        const id = Number(req.params.id);
        res.json(
          await decideRaiseRequest(db, cfg, sync, req.principal!, id, action === "approve", String(req.body.note ?? "")),
        );
      }),
    );
  }

  // ---- Admin: teams ----
  r.get("/admin/teams", requireAdmin, wrap(async (_req, res) => res.json(await db.all("SELECT * FROM teams ORDER BY name"))));

  const saveTeam = async (id: number | null, b: Record<string, unknown>, actor: string) => {
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
    if (members.length) await sync.pushCaps(members).catch((e) => console.error("cap push failed:", e));
    return db.get("SELECT * FROM teams WHERE id = ?", id);
  };

  r.post("/admin/teams", requireAdmin, wrap(async (req, res) => res.status(201).json(await saveTeam(null, req.body, req.principal!.label))));
  r.patch(
    "/admin/teams/:id",
    requireAdmin,
    wrap(async (req, res) => res.json(await saveTeam(Number(req.params.id), req.body, req.principal!.label))),
  );

  // ---- Admin: users ----
  r.get(
    "/admin/users",
    requireAdmin,
    wrap(async (_req, res) => {
      const users = await db.all<User>("SELECT * FROM users ORDER BY email");
      const out = [];
      for (const u of users) out.push({ ...publicUser(u), wallet: await walletFor(db, cfg, u) });
      res.json(out);
    }),
  );

  const ROLES = ["member", "manager", "admin"];
  const teamIdByName = async (q: Queryable, name: string | null | undefined): Promise<number | null | undefined> => {
    if (name === undefined) return undefined;
    if (name === null) return null;
    const t = await q.get<{ id: number }>("SELECT id FROM teams WHERE name = ?", name);
    if (!t) throw new HttpError(400, `unknown team "${name}"`);
    return t.id;
  };

  /** Create or update by email. Used for single edits and bulk onboarding; runs inside a transaction. */
  const upsertUser = async (q: Queryable, b: Record<string, unknown>, actor: string): Promise<User> => {
    const email = optStr(b.email, "email")?.toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "valid email is required");
    const role = b.role === undefined ? undefined : String(b.role);
    if (role !== undefined && !ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
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
      if (isUniqueViolation(e)) throw new HttpError(409, `${email}: github_login or claude_user_id is already used by another user`);
      throw e;
    }
    if (status === "disabled") await q.run("DELETE FROM web_sessions WHERE user_id = ?", u.id);
    // Re-activating someone the IdP deleted brings them back into SCIM as well.
    if (status === "active") await q.run("UPDATE users SET deleted_at = NULL WHERE id = ?", u.id);
    await audit(q, actor, "user.saved", { email, ...Object.fromEntries(sets) });
    return (await getUser(q, u.id))!;
  };

  r.post(
    "/admin/users",
    requireAdmin,
    wrap(async (req, res) => {
      const list = Array.isArray(req.body) ? req.body : [req.body];
      if (list.length > 5000) throw new HttpError(400, "at most 5000 users per call");
      const saved = await db.tx(async (q) => {
        const out: User[] = [];
        for (const b of list) out.push(await upsertUser(q, b, req.principal!.label));
        return out;
      });
      // A role, status, team or budget change moves caps; push them now.
      await sync.pushCaps(saved.map((u) => u.id)).catch((e) => console.error("cap push failed:", e));
      res.status(201).json(saved.map(publicUser));
    }),
  );

  // ---- Admin: spend ----
  r.post(
    "/admin/sync",
    requireAdmin,
    wrap(async (_req, res) => res.json(await sync.run())),
  );

  r.get("/admin/sync-runs", requireAdmin, wrap(async (_req, res) => res.json(await db.all("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 50"))));

  /** For tools without a connector yet (Codex, ...): replace one tool's spend for a period. */
  r.post(
    "/admin/spend-import",
    requireAdmin,
    wrap(async (req, res) => {
      const { period = currentPeriod(), tool, rows } = req.body as { period?: string; tool?: string; rows?: unknown };
      if (!PERIOD_RE.test(period)) throw new HttpError(400, "period must be YYYY-MM");
      if (!tool || !TOOL_RE.test(tool)) throw new HttpError(400, "tool must be a short lowercase key, e.g. codex");
      if (sync.connectors.some((c) => c.tool === tool)) throw new HttpError(409, `${tool} is synced by a connector`);
      if (!Array.isArray(rows)) throw new HttpError(400, "rows must be an array of {email, usd}");
      const ts = nowIso();
      const missing: string[] = [];
      await db.tx(async (q) => {
        await q.run("DELETE FROM spend WHERE period = ? AND tool = ?", period, tool);
        for (const row of rows as { email?: string; usd?: number }[]) {
          const u = row.email ? await getUserByEmail(q, row.email) : undefined;
          const usd = Number(row.usd);
          if (!Number.isFinite(usd) || usd < 0) throw new HttpError(400, `bad usd for ${row.email}`);
          if (!u) missing.push(String(row.email));
          else {
            await q.run(
              "INSERT INTO spend (period, user_id, tool, cents, synced_at) VALUES (?, ?, ?, ?, ?) " +
                "ON CONFLICT(period, user_id, tool) DO UPDATE SET cents = spend.cents + excluded.cents",
              period,
              u.id,
              tool,
              usdToCents(usd),
              ts,
            );
          }
        }
        await audit(q, req.principal!.label, "spend.imported", { period, tool, rows: rows.length, missing });
      });
      await sync.pushCaps().catch((e) => console.error("cap push failed:", e));
      res.json({ imported: rows.length - missing.length, unknown_emails: missing });
    }),
  );

  r.get(
    "/admin/unmatched",
    requireAdmin,
    wrap(async (req, res) => {
      const period = String(req.query.period ?? currentPeriod());
      res.json(await db.all("SELECT * FROM unmatched_spend WHERE period = ? ORDER BY cents DESC", period));
    }),
  );

  r.get(
    "/admin/report",
    requireAdmin,
    wrap(async (req, res) => {
      const period = String(req.query.period ?? currentPeriod());
      if (!PERIOD_RE.test(period)) throw new HttpError(400, "period must be YYYY-MM");
      const report = await spendReport(db, cfg, period);
      if (req.query.format === "csv") {
        res.setHeader("content-type", "text/csv; charset=utf-8");
        res.setHeader("content-disposition", `attachment; filename="devhub-spend-${period}.csv"`);
        return res.send(reportCsv(report));
      }
      res.json({ period, ...report });
    }),
  );

  r.get("/admin/license", requireAdmin, wrap(async (_req, res) => res.json(await licenseStatus(db, cfg))));

  r.put(
    "/admin/license",
    requireAdmin,
    wrap(async (req, res) => {
      const raw = req.body?.license_file;
      const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
      const parsed = parseAndVerify(text);
      if (!parsed.ok) throw new HttpError(400, parsed.error);
      await db.run(
        "INSERT INTO settings (key, value, updated_at) VALUES ('license', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        text,
        nowIso(),
      );
      await audit(db, req.principal!.label, "license.installed", {
        id: parsed.license.id,
        seats: parsed.license.seats,
        expiresAt: parsed.license.expiresAt,
      });
      res.json(await licenseStatus(db, cfg));
    }),
  );

  r.get("/admin/audit", requireAdmin, wrap(async (_req, res) => res.json(await db.all("SELECT * FROM audit ORDER BY id DESC LIMIT 200"))));

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return r;
}
