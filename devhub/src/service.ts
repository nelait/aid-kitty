import type { Config } from "./config.js";
import { audit, getUser, nowIso, tx, type Db, type RaiseRequest, type User } from "./db.js";
import type { Principal } from "./auth.js";
import type { SyncService } from "./sync.js";
import { currentPeriod, fmtUsd, usdToCents, walletFor } from "./wallet.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function notify(cfg: Config, text: string): void {
  const url = cfg.notify.slackWebhookUrl;
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => console.error("slack notify failed:", (e as Error).message));
}

export function createRaiseRequest(db: Db, cfg: Config, user: User, amountUsd: number, reason: string): RaiseRequest {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 100_000) {
    throw new HttpError(400, "amount must be between $0.01 and $100,000");
  }
  reason = reason.trim();
  if (reason.length < 5) throw new HttpError(400, "give a short reason (at least 5 characters)");
  if (reason.length > 1000) throw new HttpError(400, "reason is too long (1000 characters max)");
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM raise_requests WHERE user_id = ? AND status = 'pending'")
    .get(user.id) as { n: number };
  if (Number(pending.n) >= 3) throw new HttpError(409, "you already have 3 pending requests");

  const info = db
    .prepare("INSERT INTO raise_requests (user_id, period, amount_cents, reason) VALUES (?, ?, ?, ?)")
    .run(user.id, currentPeriod(), usdToCents(amountUsd), reason);
  const req = db.prepare("SELECT * FROM raise_requests WHERE id = ?").get(info.lastInsertRowid) as unknown as RaiseRequest;
  audit(db, user.email, "raise.requested", { id: req.id, cents: req.amount_cents });
  notify(
    cfg,
    `${user.email} requested ${fmtUsd(req.amount_cents)} more AI budget: "${reason}". Review: ${cfg.publicUrl}/approvals`,
  );
  return req;
}

/** Admins decide any request; managers decide requests from their own team. Nobody decides their own. */
export function canDecide(db: Db, p: Principal, req: RaiseRequest): boolean {
  if (p.user && p.user.id === req.user_id) return false;
  if (p.isAdmin) return true;
  if (p.user?.role !== "manager" || p.user.team_id === null) return false;
  const requester = getUser(db, req.user_id);
  return requester?.team_id === p.user.team_id;
}

export function listDecidable(db: Db, p: Principal, status = "pending") {
  const rows = db
    .prepare(
      `SELECT r.*, u.email, u.team_id FROM raise_requests r JOIN users u ON u.id = r.user_id
       WHERE r.status = ? ORDER BY r.created_at`,
    )
    .all(status) as unknown as (RaiseRequest & { email: string; team_id: number | null })[];
  return rows.filter((r) => canDecide(db, p, r));
}

export async function decideRaiseRequest(
  db: Db,
  cfg: Config,
  sync: SyncService,
  p: Principal,
  id: number,
  approve: boolean,
  note: string,
): Promise<RaiseRequest> {
  const req = db.prepare("SELECT * FROM raise_requests WHERE id = ?").get(id) as RaiseRequest | undefined;
  if (!req) throw new HttpError(404, "request not found");
  if (!canDecide(db, p, req)) throw new HttpError(403, "you can't decide this request");

  const decided = tx(db, () => {
    const res = db
      .prepare(
        "UPDATE raise_requests SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(approve ? "approved" : "denied", p.user?.id ?? null, note.trim() || null, nowIso(), id);
    if (Number(res.changes) === 0) throw new HttpError(409, "request was already decided");
    return db.prepare("SELECT * FROM raise_requests WHERE id = ?").get(id) as unknown as RaiseRequest;
  });
  audit(db, p.label, approve ? "raise.approved" : "raise.denied", { id, cents: req.amount_cents });

  const requester = getUser(db, req.user_id)!;
  notify(
    cfg,
    `${p.label} ${approve ? "approved" : "denied"} ${fmtUsd(req.amount_cents)} for ${requester.email}` +
      (note.trim() ? `: "${note.trim()}"` : ""),
  );
  // An approval raises the Claude cap right away instead of waiting for the next sync.
  if (approve && req.period === currentPeriod()) {
    await sync.pushCaps([req.user_id]).catch((e) => console.error("cap push after approval failed:", e));
  }
  return decided;
}

export interface ReportRow {
  email: string;
  name: string | null;
  team: string | null;
  cost_center: string | null;
  limit_cents: number;
  spend_cents: number;
  by_tool: Record<string, number>;
}

export function spendReport(db: Db, cfg: Config, period: string): { tools: string[]; rows: ReportRow[] } {
  const users = db.prepare("SELECT * FROM users ORDER BY email").all() as unknown as User[];
  const teams = new Map(
    (db.prepare("SELECT id, name, cost_center FROM teams").all() as { id: number; name: string; cost_center: string | null }[]).map(
      (t) => [t.id, t],
    ),
  );
  const tools = (db.prepare("SELECT DISTINCT tool FROM spend WHERE period = ? ORDER BY tool").all(period) as { tool: string }[]).map(
    (t) => t.tool,
  );
  const rows: ReportRow[] = [];
  for (const u of users) {
    const w = walletFor(db, cfg, u, period);
    if (w.spendCents === 0 && u.status !== "active") continue;
    const team = u.team_id !== null ? teams.get(u.team_id) : undefined;
    rows.push({
      email: u.email,
      name: u.name,
      team: team?.name ?? null,
      cost_center: team?.cost_center ?? null,
      limit_cents: w.limitCents,
      spend_cents: w.spendCents,
      by_tool: w.spendByTool,
    });
  }
  return { tools, rows };
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  // Neutralize spreadsheet formula injection from user-controlled fields.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function reportCsv(report: { tools: string[]; rows: ReportRow[] }): string {
  const head = ["email", "name", "team", "cost_center", ...report.tools.map((t) => `${t}_usd`), "total_usd", "limit_usd"];
  const lines = [head.join(",")];
  for (const r of report.rows) {
    lines.push(
      [
        r.email,
        r.name,
        r.team,
        r.cost_center,
        ...report.tools.map((t) => ((r.by_tool[t] ?? 0) / 100).toFixed(2)),
        (r.spend_cents / 100).toFixed(2),
        (r.limit_cents / 100).toFixed(2),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
