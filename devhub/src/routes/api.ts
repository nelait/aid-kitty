import express, { type NextFunction, type Request, type Response } from "express";
import { requireAdmin, requireUser } from "../auth.js";
import type { Config } from "../config.js";
import { audit, getUser, getUserByEmail, nowIso, tx, type Db, type User } from "../db.js";
import {
  HttpError,
  createRaiseRequest,
  decideRaiseRequest,
  listDecidable,
  reportCsv,
  spendReport,
} from "../service.js";
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
    wrap((req, res) => {
      const u = req.principal!.user;
      if (!u) throw new HttpError(400, "the automation token has no wallet");
      res.json({ user: publicUser(u), wallet: walletFor(db, cfg, u), csrf: req.principal!.csrf });
    }),
  );

  r.get(
    "/me/raise-requests",
    requireUser,
    wrap((req, res) => {
      const u = req.principal!.user;
      if (!u) throw new HttpError(400, "the automation token has no wallet");
      res.json(db.prepare("SELECT * FROM raise_requests WHERE user_id = ? ORDER BY id DESC").all(u.id));
    }),
  );

  r.post(
    "/me/raise-requests",
    requireUser,
    wrap((req, res) => {
      const u = req.principal!.user;
      if (!u) throw new HttpError(400, "the automation token has no wallet");
      res.status(201).json(createRaiseRequest(db, cfg, u, Number(req.body.amount_usd), String(req.body.reason ?? "")));
    }),
  );

  // ---- Approvals (managers for their team, admins for everyone) ----
  r.get(
    "/raise-requests",
    requireUser,
    wrap((req, res) => {
      const status = String(req.query.status ?? "pending");
      if (!["pending", "approved", "denied"].includes(status)) throw new HttpError(400, "bad status");
      res.json(listDecidable(db, req.principal!, status));
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
  r.get("/admin/teams", requireAdmin, (_req, res) => {
    res.json(db.prepare("SELECT * FROM teams ORDER BY name").all());
  });

  const saveTeam = (id: number | null, b: Record<string, unknown>, actor: string) => {
    const name = optStr(b.name, "name");
    const cost = optStr(b.cost_center, "cost_center");
    const pool = optUsdToCents(b.monthly_pool_usd, "monthly_pool_usd");
    const def = optUsdToCents(b.member_default_usd, "member_default_usd");
    if (id === null) {
      if (!name) throw new HttpError(400, "name is required");
      const info = db
        .prepare("INSERT INTO teams (name, cost_center, monthly_pool_cents, member_default_cents) VALUES (?, ?, ?, ?)")
        .run(name, cost ?? null, pool ?? null, def ?? null);
      id = Number(info.lastInsertRowid);
    } else {
      const t = db.prepare("SELECT * FROM teams WHERE id = ?").get(id);
      if (!t) throw new HttpError(404, "team not found");
      const sets: [string, unknown][] = [];
      if (name) sets.push(["name", name]);
      if (cost !== undefined) sets.push(["cost_center", cost]);
      if (pool !== undefined) sets.push(["monthly_pool_cents", pool]);
      if (def !== undefined) sets.push(["member_default_cents", def]);
      if (sets.length) {
        db.prepare(`UPDATE teams SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
          ...(sets.map(([, v]) => v) as (string | number | null)[]),
          id,
        );
      }
    }
    audit(db, actor, "team.saved", { id, ...b });
    return db.prepare("SELECT * FROM teams WHERE id = ?").get(id);
  };

  r.post("/admin/teams", requireAdmin, wrap((req, res) => res.status(201).json(saveTeam(null, req.body, req.principal!.label))));
  r.patch("/admin/teams/:id", requireAdmin, wrap((req, res) => res.json(saveTeam(Number(req.params.id), req.body, req.principal!.label))));

  // ---- Admin: users ----
  r.get("/admin/users", requireAdmin, (_req, res) => {
    const users = db.prepare("SELECT * FROM users ORDER BY email").all() as unknown as User[];
    res.json(users.map((u) => ({ ...publicUser(u), wallet: walletFor(db, cfg, u) })));
  });

  const ROLES = ["member", "manager", "admin"];
  const teamIdByName = (name: string | null | undefined): number | null | undefined => {
    if (name === undefined) return undefined;
    if (name === null) return null;
    const t = db.prepare("SELECT id FROM teams WHERE name = ?").get(name) as { id: number } | undefined;
    if (!t) throw new HttpError(400, `unknown team "${name}"`);
    return t.id;
  };

  /** Create or update by email. Used for single edits and bulk onboarding. */
  const upsertUser = (b: Record<string, unknown>, actor: string): User => {
    const email = optStr(b.email, "email")?.toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "valid email is required");
    const role = b.role === undefined ? undefined : String(b.role);
    if (role !== undefined && !ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
    const status = b.status === undefined ? undefined : String(b.status);
    if (status !== undefined && !["active", "disabled"].includes(status)) throw new HttpError(400, "bad status");
    const fields: Record<string, unknown> = {
      name: optStr(b.name, "name"),
      team_id: teamIdByName(optStr(b.team, "team")),
      role,
      status,
      github_login: optStr(b.github_login, "github_login"),
      claude_user_id: optStr(b.claude_user_id, "claude_user_id"),
      monthly_budget_cents: optUsdToCents(b.monthly_budget_usd, "monthly_budget_usd"),
    };
    const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
    let u = getUserByEmail(db, email);
    try {
      if (!u) {
        db.prepare("INSERT INTO users (email) VALUES (?)").run(email);
        u = getUserByEmail(db, email)!;
      }
      if (sets.length) {
        db.prepare(`UPDATE users SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
          ...(sets.map(([, v]) => v) as (string | number | null)[]),
          u.id,
        );
      }
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new HttpError(409, `${email}: github_login or claude_user_id is already used by another user`);
      }
      throw e;
    }
    if (status === "disabled") db.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(u.id);
    // Re-activating someone the IdP deleted brings them back into SCIM as well.
    if (status === "active") db.prepare("UPDATE users SET deleted_at = NULL WHERE id = ?").run(u.id);
    audit(db, actor, "user.saved", { email, ...Object.fromEntries(sets) });
    return getUser(db, u.id)!;
  };

  r.post(
    "/admin/users",
    requireAdmin,
    wrap(async (req, res) => {
      const list = Array.isArray(req.body) ? req.body : [req.body];
      if (list.length > 5000) throw new HttpError(400, "at most 5000 users per call");
      const saved = tx(db, () => list.map((b) => upsertUser(b, req.principal!.label)));
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

  r.get("/admin/sync-runs", requireAdmin, (_req, res) => {
    res.json(db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 50").all());
  });

  /** For tools without a connector yet (Cursor, Codex, ...): replace one tool's spend for a period. */
  r.post(
    "/admin/spend-import",
    requireAdmin,
    wrap((req, res) => {
      const { period = currentPeriod(), tool, rows } = req.body as { period?: string; tool?: string; rows?: unknown };
      if (!PERIOD_RE.test(period)) throw new HttpError(400, "period must be YYYY-MM");
      if (!tool || !TOOL_RE.test(tool)) throw new HttpError(400, "tool must be a short lowercase key, e.g. cursor");
      if (sync.connectors.some((c) => c.tool === tool)) throw new HttpError(409, `${tool} is synced by a connector`);
      if (!Array.isArray(rows)) throw new HttpError(400, "rows must be an array of {email, usd}");
      const ts = nowIso();
      const missing: string[] = [];
      tx(db, () => {
        db.prepare("DELETE FROM spend WHERE period = ? AND tool = ?").run(period, tool);
        const ins = db.prepare(
          "INSERT INTO spend (period, user_id, tool, cents, synced_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(period, user_id, tool) DO UPDATE SET cents = cents + excluded.cents",
        );
        for (const row of rows as { email?: string; usd?: number }[]) {
          const u = row.email ? getUserByEmail(db, row.email) : undefined;
          const usd = Number(row.usd);
          if (!Number.isFinite(usd) || usd < 0) throw new HttpError(400, `bad usd for ${row.email}`);
          if (!u) missing.push(String(row.email));
          else ins.run(period, u.id, tool, usdToCents(usd), ts);
        }
      });
      audit(db, req.principal!.label, "spend.imported", { period, tool, rows: rows.length, missing });
      sync.pushCaps().catch((e) => console.error("cap push failed:", e));
      res.json({ imported: rows.length - missing.length, unknown_emails: missing });
    }),
  );

  r.get("/admin/unmatched", requireAdmin, (req, res) => {
    const period = String(req.query.period ?? currentPeriod());
    res.json(db.prepare("SELECT * FROM unmatched_spend WHERE period = ? ORDER BY cents DESC").all(period));
  });

  r.get(
    "/admin/report",
    requireAdmin,
    wrap((req, res) => {
      const period = String(req.query.period ?? currentPeriod());
      if (!PERIOD_RE.test(period)) throw new HttpError(400, "period must be YYYY-MM");
      const report = spendReport(db, cfg, period);
      if (req.query.format === "csv") {
        res.setHeader("content-type", "text/csv; charset=utf-8");
        res.setHeader("content-disposition", `attachment; filename="devhub-spend-${period}.csv"`);
        return res.send(reportCsv(report));
      }
      res.json({ period, ...report });
    }),
  );

  r.get("/admin/audit", requireAdmin, (_req, res) => {
    res.json(db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 200").all());
  });

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return r;
}
