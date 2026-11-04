import express, { type NextFunction, type Request, type Response } from "express";
import { requireAdmin, requireUser } from "../auth.js";
import type { Config } from "../config.js";
import { audit, getUserByEmail, nowIso, type Db, type User } from "../db.js";
import { installLicense, publicUser, saveTeam, upsertUsers } from "../admin.js";
import {
  HttpError,
  createRaiseRequest,
  decideRaiseRequest,
  listDecidable,
  reportCsv,
  spendReport,
} from "../service.js";
import { licenseStatus } from "../license.js";
import type { SyncService } from "../sync.js";
import { currentPeriod, usdToCents, walletFor } from "../wallet.js";

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TOOL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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

  r.post("/admin/teams", requireAdmin, wrap(async (req, res) => res.status(201).json(await saveTeam(db, sync, null, req.body, req.principal!.label))));
  r.patch(
    "/admin/teams/:id",
    requireAdmin,
    wrap(async (req, res) => res.json(await saveTeam(db, sync, Number(req.params.id), req.body, req.principal!.label))),
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

  r.post(
    "/admin/users",
    requireAdmin,
    wrap(async (req, res) => {
      const list = Array.isArray(req.body) ? req.body : [req.body];
      const saved = await upsertUsers(db, cfg, sync, list, req.principal!.label);
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
      await installLicense(db, text, req.principal!.label);
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
