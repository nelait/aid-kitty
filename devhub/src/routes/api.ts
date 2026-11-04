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
import { roiCsv, roiReport } from "../roi.js";
import { validateSshKey } from "../workspaces.js";
import { timingSafeEqual } from "node:crypto";
import {
  applyCopilotExclusions,
  claudeSettings,
  effective,
  effectiveForEmail,
  gatewayManagedYaml,
  getOrgPolicy,
  getTeamPolicy,
  helperScript,
  policyVersion,
  saveOrgPolicy,
  saveTeamPolicy,
} from "../policy.js";
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
      await sync.afterChange();
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

  // ---- Workspaces ----
  const ws = sync.workspaces;
  const owned = async (req: Request) => {
    const u = req.principal!.user;
    if (!u) throw new HttpError(400, "the automation token has no workspaces");
    const w = await ws.get(Number(req.params.id));
    if (w.user_id !== u.id || w.state === "terminated") throw new HttpError(404, "workspace not found");
    return { u, w };
  };
  const withHint = (w: Awaited<ReturnType<typeof ws.get>>) => ({
    ...w,
    connect: ws.hintFor(w),
  });

  r.get(
    "/me/workspaces",
    requireUser,
    wrap(async (req, res) => {
      const u = req.principal!.user;
      if (!u) throw new HttpError(400, "the automation token has no workspaces");
      const key = await db.get<{ k: string | null }>("SELECT ssh_public_key AS k FROM users WHERE id = ?", u.id);
      res.json({
        enabled: ws.enabled,
        ssh_public_key: key?.k ?? null,
        templates: (await ws.templates(true)).map((t) => ({ id: t.id, name: t.name, hourly_usd: t.hourly_usd_e4 / 10_000, stop_after_hours: t.stop_after_hours })),
        workspaces: (await ws.listFor(u.id)).map(withHint),
      });
    }),
  );
  r.put(
    "/me/ssh-key",
    requireUser,
    wrap(async (req, res) => {
      const u = req.principal!.user;
      if (!u) throw new HttpError(400, "the automation token has no SSH key");
      const key = validateSshKey(String(req.body?.ssh_public_key ?? ""));
      await db.run("UPDATE users SET ssh_public_key = ? WHERE id = ?", key, u.id);
      await audit(db, u.email, "ssh_key.saved", { fingerprintHint: key.slice(-20) });
      res.json({ ok: true });
    }),
  );
  r.post(
    "/me/workspaces",
    requireUser,
    wrap(async (req, res) => {
      const u = req.principal!.user;
      if (!u) throw new HttpError(400, "the automation token has no workspaces");
      res.status(201).json(withHint(await ws.create(u, Number(req.body?.template_id), String(req.body?.name ?? ""))));
    }),
  );
  r.post(
    "/me/workspaces/:id/:action(start|stop|extend|delete)",
    requireUser,
    wrap(async (req, res) => {
      const { u, w } = await owned(req);
      const a = req.params.action;
      if (a === "start") await ws.start(u, w);
      else if (a === "stop") await ws.stop(w, u.email);
      else if (a === "extend") await ws.extend(w, u.email);
      else await ws.destroy(w, u.email);
      res.json(withHint(await ws.get(w.id)));
    }),
  );

  r.get("/admin/workspace-templates", requireAdmin, wrap(async (_req, res) => res.json(await ws.templates())));
  r.post("/admin/workspace-templates", requireAdmin, wrap(async (req, res) => res.status(201).json(await ws.saveTemplate(null, req.body ?? {}, req.principal!.label))));
  r.put(
    "/admin/workspace-templates/:id",
    requireAdmin,
    wrap(async (req, res) => res.json(await ws.saveTemplate(Number(req.params.id), req.body ?? {}, req.principal!.label))),
  );
  r.get("/admin/workspaces", requireAdmin, wrap(async (_req, res) => res.json(await ws.listAll())));
  r.post(
    "/admin/workspaces/:id/:action(stop|delete)",
    requireAdmin,
    wrap(async (req, res) => {
      const w = await ws.get(Number(req.params.id));
      if (req.params.action === "stop") await ws.stop(w, req.principal!.label);
      else await ws.destroy(w, req.principal!.label);
      res.json(await ws.get(w.id));
    }),
  );

  // ---- Return on spend ----
  r.get(
    "/admin/roi",
    requireAdmin,
    wrap(async (req, res) => {
      const period = String(req.query.period ?? currentPeriod());
      if (!PERIOD_RE.test(period)) throw new HttpError(400, "period must be YYYY-MM");
      const report = await roiReport(db, period);
      if (req.query.format === "csv") {
        res.setHeader("content-type", "text/csv; charset=utf-8");
        res.setHeader("content-disposition", `attachment; filename="devhub-return-on-spend-${period}.csv"`);
        return res.send(roiCsv(report));
      }
      res.json({ ...report, refreshed: await sync.output.lastRefresh(period) });
    }),
  );
  r.post(
    "/admin/roi/refresh",
    requireAdmin,
    wrap(async (req, res) => {
      const period = String(req.body?.period ?? currentPeriod());
      if (!PERIOD_RE.test(period)) throw new HttpError(400, "period must be YYYY-MM");
      if (!sync.output.enabled) throw new HttpError(400, "GitHub isn't configured (set GITHUB_ORG and GITHUB_TOKEN)");
      res.json(await sync.output.refresh(period));
    }),
  );

  // ---- Policy ----
  r.get(
    "/admin/policy",
    requireAdmin,
    wrap(async (_req, res) => {
      const teams = await db.all<{ id: number; name: string }>("SELECT id, name FROM teams ORDER BY name");
      const out = [];
      for (const t of teams) out.push({ ...t, policy: await getTeamPolicy(db, t.id) });
      res.json({ version: await policyVersion(db), org: await getOrgPolicy(db), teams: out });
    }),
  );
  r.put("/admin/policy", requireAdmin, wrap(async (req, res) => res.json(await saveOrgPolicy(db, req.body ?? {}, req.principal!.label))));
  r.put(
    "/admin/policy/teams/:id",
    requireAdmin,
    wrap(async (req, res) => res.json(await saveTeamPolicy(db, Number(req.params.id), req.body ?? {}, req.principal!.label))),
  );
  r.get(
    "/admin/policy/claude-managed-settings.json",
    requireAdmin,
    wrap(async (req, res) => {
      const org = await getOrgPolicy(db);
      const teamId = Number(req.query.team);
      const team = teamId ? await db.get<{ id: number; name: string }>("SELECT id, name FROM teams WHERE id = ?", teamId) : undefined;
      const p = team ? effective(org, { name: team.name, policy: await getTeamPolicy(db, team.id) }) : effective(org);
      res.setHeader("content-disposition", 'attachment; filename="managed-settings.json"');
      res.json(claudeSettings(p));
    }),
  );
  r.get(
    "/admin/policy/gateway.yaml",
    requireAdmin,
    wrap(async (_req, res) => {
      res.setHeader("content-type", "text/yaml; charset=utf-8");
      res.setHeader("content-disposition", 'attachment; filename="gateway-managed.yaml"');
      res.send(await gatewayManagedYaml(db));
    }),
  );
  r.get("/admin/policy/devhub-policy.sh", requireAdmin, (_req, res) => {
    res.setHeader("content-type", "text/x-shellscript; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="devhub-policy"');
    res.send(helperScript(cfg));
  });
  r.post(
    "/admin/policy/copilot",
    requireAdmin,
    wrap(async (req, res) => res.json(await applyCopilotExclusions(db, cfg, req.principal!.label, req.body?.dryRun !== false))),
  );

  /**
   * What Claude Code's policyHelper fetches on developers' machines. Read-only, with its own
   * token so laptops never hold an admin credential.
   */
  r.get(
    "/policy/claude-code",
    wrap(async (req, res) => {
      const sent = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
      const token = cfg.policyToken ?? "";
      const tokenOk = !!token && sent.length === token.length && timingSafeEqual(Buffer.from(sent), Buffer.from(token));
      if (!tokenOk && !req.principal?.isAdmin) return res.status(401).json({ error: "policy token required" });
      const email = typeof req.query.email === "string" && req.query.email.includes("@") ? req.query.email : undefined;
      const p = await effectiveForEmail(db, email);
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-devhub-policy-version", await policyVersion(db));
      res.setHeader("x-devhub-policy-team", p.team ?? "");
      res.json({ managedSettings: claudeSettings(p) });
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
