import express, { type NextFunction, type Request, type Response } from "express";
import { adminTabs, back, csrfField, esc, flash, page, wrap } from "./html.js";
import { csrfOk, type Principal } from "../auth.js";
import type { Config } from "../config.js";
import type { Db, RaiseRequest, User } from "../db.js";
import { HttpError, createRaiseRequest, decideRaiseRequest, listDecidable, spendReport } from "../service.js";
import { licenseStatus, type LicenseStatus } from "../license.js";
import type { SyncService } from "../sync.js";
import { currentPeriod, fmtUsd, walletFor, type WalletStatus } from "../wallet.js";

function loginPage(cfg: Config): string {
  const sso = cfg.auth.oidc
    ? `<p><a href="/auth/login"><button type="button">Sign in with SSO</button></a></p>`
    : `<p class="muted">SSO is not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.</p>`;
  const dev = cfg.auth.devLogin
    ? `<form method="post" action="/auth/dev-login" class="row"><div><label>Email (development login)</label>
       <input name="email" type="email" required></div><div style="flex:0 0 auto;min-width:0"><button>Sign in</button></div></form>`
    : "";
  return page(
    "Sign in",
    undefined,
    `<div class="card"><h1>Sign in to Dev Hub</h1><p class="muted">Your AI tools, budget and approvals in one place.</p>${sso}${dev}</div>`,
  );
}

function walletCard(cfg: Config, w: WalletStatus): string {
  const pct = w.limitCents > 0 ? Math.min(100, Math.round((w.spendCents / w.limitCents) * 100)) : 100;
  const tools = Object.entries(w.spendByTool)
    .map(([t, c]) => `<tr><td>${esc(t)}</td><td class="n">${fmtUsd(c)}</td></tr>`)
    .join("");
  const team = w.team
    ? `<p class="muted">Team ${esc(w.team.name)}: ${fmtUsd(w.team.spendCents)} spent${
        w.team.poolCents !== null ? ` of a ${fmtUsd(w.team.poolCents)} team pool` : ""
      }.</p>`
    : "";
  return `<div class="card"><h2>AI budget for ${esc(w.period)}</h2>
    <div class="big">${fmtUsd(w.remainingCents)} <span class="muted" style="font-size:15px;font-weight:400">left of ${fmtUsd(w.limitCents)}</span></div>
    <div class="bar"><div class="${w.state}" style="width:${pct}%"></div></div>
    <p class="muted">${fmtUsd(w.spendCents)} spent (${pct}%).${w.approvedRaisesCents ? ` Includes ${fmtUsd(w.approvedRaisesCents)} of approved increases.` : ""}
    ${w.state === "exhausted" ? " Your budget is used up; Claude requests are blocked until it resets or an increase is approved." : ""}</p>
    ${team}
    ${tools ? `<table><thead><tr><th>Tool</th><th class="n">Spent</th></tr></thead><tbody>${tools}</tbody></table>` : `<p class="muted">No spend recorded yet this month.</p>`}
  </div>`;
}

function licenseCard(l: LicenseStatus): string {
  const attention = l.state !== "valid" || !l.canActivate || l.activeUsers > l.seats;
  return `<div class="card"${attention ? ' style="border-color:var(--warn)"' : ""}><h2>License</h2>
    <p>${esc(l.message)}</p><p class="muted">${l.activeUsers} active people · ${l.seats} seats${
      l.licenseId ? ` · ${esc(l.licenseId)}` : ""
    }. <a href="/admin/license">Manage license</a></p></div>`;
}

function requestsTable(rows: RaiseRequest[]): string {
  if (!rows.length) return `<p class="muted">No requests yet.</p>`;
  return `<div class="scroll"><table><thead><tr><th>Date</th><th class="n">Amount</th><th>Reason</th><th>Status</th></tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><td>${esc(r.created_at.slice(0, 10))}</td><td class="n">${fmtUsd(r.amount_cents)}</td><td>${esc(r.reason)}</td>
         <td>${esc(r.status)}${r.decision_note ? `<div class="muted">${esc(r.decision_note)}</div>` : ""}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

export function portalRoutes(db: Db, cfg: Config, sync: SyncService) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const signedIn = (req: Request, res: Response): Principal | null => {
    const p = req.principal;
    if (!p?.user) {
      res.status(401).send(loginPage(cfg));
      return null;
    }
    return p;
  };

  r.get("/", wrap(async (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    const u = p.user!;
    const w = await walletFor(db, cfg, u);
    const mine = await db.all<RaiseRequest>("SELECT * FROM raise_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20", u.id);
    const gw = cfg.claudeGatewayUrl;
    const connect = gw
      ? `<p>Run <code>claude</code>, type <code>/login</code>, choose <b>Cloud gateway</b> and enter:</p><pre>${esc(gw)}</pre>
         <p class="muted">Sign in with your company SSO. Your spend counts against the budget above.</p>`
      : `<p class="muted">Your admin has not set the Claude gateway URL yet.</p>`;
    res.send(
      page(
        "My wallet",
        p,
        `${flash(req)}<h1>Hi ${esc(u.name ?? u.email)}</h1>
        ${walletCard(cfg, w)}
        <div class="card"><h2>Need more budget?</h2>
          <form method="post" action="/portal/raise">${csrfField(p)}
            <div class="row"><div style="flex:0 0 140px"><label>Amount (USD)</label><input name="amount_usd" type="number" min="1" step="1" required></div>
            <div><label>Reason</label><input name="reason" maxlength="1000" required placeholder="e.g. migration sprint, large refactor"></div>
            <div style="flex:0 0 auto;min-width:0"><button>Request</button></div></div></form>
          <h2 style="margin-top:16px">My requests</h2>${requestsTable(mine)}
        </div>
        <div class="card"><h2>Connect Claude Code</h2>${connect}</div>`,
      ),
    );
  }));

  r.post("/portal/raise", wrap(async (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    if (!csrfOk(req)) return res.status(403).send("Bad CSRF token; reload the page.");
    try {
      await createRaiseRequest(db, cfg, p.user!, Number(req.body.amount_usd), String(req.body.reason ?? ""));
      back(res, "/", "Request sent to your manager.");
    } catch (e) {
      back(res, "/", e instanceof HttpError ? e.message : "Something went wrong.");
    }
  }));

  r.get("/approvals", wrap(async (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    const list = await listDecidable(db, p);
    const wallets = new Map<number, WalletStatus>();
    for (const rq of list) {
      const requester = (await db.get<User>("SELECT * FROM users WHERE id = ?", rq.user_id))!;
      wallets.set(rq.id, await walletFor(db, cfg, requester));
    }
    const body = list.length
      ? list
          .map((rq) => {
            const w = wallets.get(rq.id)!;
            return `<div class="card"><h2>${esc(rq.email)} asks for ${fmtUsd(rq.amount_cents)}</h2>
              <p>${esc(rq.reason)}</p>
              <p class="muted">This month: ${fmtUsd(w.spendCents)} spent of ${fmtUsd(w.limitCents)}. Requested ${esc(rq.created_at.slice(0, 16).replace("T", " "))} UTC.</p>
              <form method="post" action="/portal/requests/${rq.id}/decision" class="row">${csrfField(p)}
                <div><input name="note" placeholder="Note (optional)" maxlength="500"></div>
                <div style="flex:0 0 auto;min-width:0;display:flex;gap:8px"><button name="decision" value="approve">Approve</button>
                <button class="ghost" name="decision" value="deny">Deny</button></div></form></div>`;
          })
          .join("")
      : `<div class="card"><p class="muted">Nothing waiting for you.</p></div>`;
    res.send(page("Approvals", p, `${flash(req)}<h1>Budget requests</h1>${body}`));
  }));

  r.post("/portal/requests/:id/decision", wrap(async (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    if (!csrfOk(req)) return res.status(403).send("Bad CSRF token; reload the page.");
    try {
      const approve = req.body.decision === "approve";
      await decideRaiseRequest(db, cfg, sync, p, Number(req.params.id), approve, String(req.body.note ?? ""));
      back(res, "/approvals", approve ? "Approved. The new budget applies right away." : "Denied.");
    } catch (e) {
      back(res, "/approvals", e instanceof HttpError ? e.message : "Something went wrong.");
    }
  }));

  r.get("/admin", wrap(async (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    if (!p.isAdmin) return res.status(403).send(page("Admin", p, `<div class="card">Admins only.</div>`));
    const period = currentPeriod();
    const report = await spendReport(db, cfg, period);
    const teams = new Map<string, { spend: number; limit: number; users: number }>();
    for (const row of report.rows) {
      const k = row.team ?? "(no team)";
      const t = teams.get(k) ?? { spend: 0, limit: 0, users: 0 };
      t.spend += row.spend_cents;
      t.limit += row.limit_cents;
      t.users++;
      teams.set(k, t);
    }
    const runs = await db.all<{ ts: string; connector: string; ok: number; message: string }>(
      "SELECT * FROM sync_runs ORDER BY id DESC LIMIT 6",
    );
    const unmatched = await db.all<{ tool: string; n: number; c: number }>(
      "SELECT tool, COUNT(*) AS n, SUM(cents) AS c FROM unmatched_spend WHERE period = ? GROUP BY tool",
      period,
    );
    const license = await licenseStatus(db, cfg);
    const toolCols = report.tools;
    res.send(
      page(
        "Admin",
        p,
        `${flash(req)}<h1>Admin</h1>${adminTabs("/admin")}${licenseCard(license)}<h2 style="font-size:18px">Spend for ${esc(period)}</h2>
        <div class="card scroll"><h2>By team</h2><table><thead><tr><th>Team</th><th class="n">People</th><th class="n">Spent</th><th class="n">Budgets</th></tr></thead><tbody>
          ${[...teams]
            .sort((a, b) => b[1].spend - a[1].spend)
            .map(([k, t]) => `<tr><td>${esc(k)}</td><td class="n">${t.users}</td><td class="n">${fmtUsd(t.spend)}</td><td class="n">${fmtUsd(t.limit)}</td></tr>`)
            .join("")}</tbody></table>
          <p><a href="/api/admin/report?format=csv&period=${esc(period)}">Download chargeback CSV</a></p></div>
        <div class="card scroll"><h2>By person</h2><table><thead><tr><th>Person</th><th>Team</th>${toolCols
          .map((t) => `<th class="n">${esc(t)}</th>`)
          .join("")}<th class="n">Total</th><th class="n">Budget</th></tr></thead><tbody>
          ${report.rows
            .sort((a, b) => b.spend_cents - a.spend_cents)
            .map(
              (row) =>
                `<tr><td>${esc(row.email)}</td><td>${esc(row.team ?? "")}</td>${toolCols
                  .map((t) => `<td class="n">${fmtUsd(row.by_tool[t] ?? 0)}</td>`)
                  .join("")}<td class="n">${fmtUsd(row.spend_cents)}</td><td class="n">${fmtUsd(row.limit_cents)}</td></tr>`,
            )
            .join("")}</tbody></table></div>
        <div class="card"><h2>Sync</h2>
          ${unmatched.length ? `<p>Spend from identities not linked to anyone: ${unmatched.map((u) => `${esc(u.tool)} ${u.n} (${fmtUsd(Number(u.c))})`).join(", ")}. See <code>GET /api/admin/unmatched</code>.</p>` : ""}
          <table><tbody>${runs
            .map((s) => `<tr><td>${esc(s.ts.slice(0, 19).replace("T", " "))}</td><td>${esc(s.connector)}</td><td>${s.ok ? "ok" : "<b>failed</b>"}</td><td>${esc(s.message)}</td></tr>`)
            .join("")}</tbody></table>
          <form method="post" action="/portal/sync" style="margin-top:10px">${csrfField(p)}<button>Sync now</button></form></div>`,
      ),
    );
  }));

  r.post("/portal/sync", wrap(async (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    if (!p.isAdmin || !csrfOk(req)) return res.status(403).send("Forbidden");
    const results = await sync.run();
    back(res, "/admin", results.map((x) => `${x.connector}: ${x.ok ? "ok" : "failed"}`).join("; ") || "No connectors configured.");
  }));

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).send(page("Error", undefined, `<div class="card">Something went wrong. Try again.</div>`));
  });

  return r;
}
