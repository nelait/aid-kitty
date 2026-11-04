import express, { type Request, type Response } from "express";
import { csrfOk, type Principal } from "../auth.js";
import type { Config } from "../config.js";
import type { Db, RaiseRequest, User } from "../db.js";
import { HttpError, createRaiseRequest, decideRaiseRequest, listDecidable, spendReport } from "../service.js";
import { licenseStatus, type LicenseStatus } from "../license.js";
import type { SyncService } from "../sync.js";
import { currentPeriod, fmtUsd, walletFor } from "../wallet.js";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--accent:#3355cc;--ok:#2f8a4c;--warn:#b7791f;--bad:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#7f9cff;--ok:#5cc07c;--warn:#e0a84a;--bad:#ef6f61}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
header b{margin-right:auto}header a{color:var(--fg);text-decoration:none}header form{margin:0}
main{max-width:960px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
h1{font-size:22px;margin:4px 0 12px}h2{font-size:16px;margin:0 0 10px}
.muted{color:var(--muted)}.big{font-size:28px;font-weight:600}
.bar{height:10px;background:var(--line);border-radius:5px;overflow:hidden;margin:8px 0}.bar>div{height:100%}
.ok{background:var(--ok)}.warning{background:var(--warn)}.exhausted{background:var(--bad)}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;color:#fff}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.scroll{overflow-x:auto}
input,textarea,button{font:inherit}input,textarea{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.ghost{background:transparent;color:var(--accent)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.row>*{flex:1;min-width:140px}
code,pre{font:13px ui-monospace,Menlo,monospace}pre{background:var(--bg);border:1px solid var(--line);padding:10px;border-radius:6px;overflow-x:auto}
.flash{padding:10px 12px;border-radius:6px;margin-bottom:16px;border:1px solid var(--line);background:var(--card)}
`;

function page(title: string, p: Principal | undefined, body: string): string {
  const nav = p
    ? `<a href="/">My wallet</a>
       ${p.isAdmin || p.user?.role === "manager" ? `<a href="/approvals">Approvals</a>` : ""}
       ${p.isAdmin ? `<a href="/admin">Admin</a>` : ""}
       <form method="post" action="/auth/logout"><button class="ghost" type="submit">Sign out</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Dev Hub</title><style>${CSS}</style></head>
<body><header><b>Dev Hub</b>${nav}</header><main>${body}</main></body></html>`;
}

const flash = (req: Request) => {
  const m = typeof req.query.msg === "string" ? req.query.msg : "";
  return m ? `<div class="flash">${esc(m)}</div>` : "";
};

const back = (res: Response, path: string, msg: string) => res.redirect(`${path}?msg=${encodeURIComponent(msg)}`);

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

function walletCard(cfg: Config, w: ReturnType<typeof walletFor>): string {
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
    }. Install a license with <code>PUT /api/admin/license</code>.</p></div>`;
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
  const csrfField = (p: Principal) => `<input type="hidden" name="_csrf" value="${esc(p.csrf)}">`;

  r.get("/", (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    const u = p.user!;
    const w = walletFor(db, cfg, u);
    const mine = db.prepare("SELECT * FROM raise_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20").all(u.id) as unknown as RaiseRequest[];
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
  });

  r.post("/portal/raise", (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    if (!csrfOk(req)) return res.status(403).send("Bad CSRF token; reload the page.");
    try {
      createRaiseRequest(db, cfg, p.user!, Number(req.body.amount_usd), String(req.body.reason ?? ""));
      back(res, "/", "Request sent to your manager.");
    } catch (e) {
      back(res, "/", e instanceof HttpError ? e.message : "Something went wrong.");
    }
  });

  r.get("/approvals", (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    const rows = listDecidable(db, p);
    const body = rows.length
      ? rows
          .map((rq) => {
            const requester = db.prepare("SELECT * FROM users WHERE id = ?").get(rq.user_id) as unknown as User;
            const w = walletFor(db, cfg, requester);
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
  });

  r.post("/portal/requests/:id/decision", async (req, res) => {
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
  });

  r.get("/admin", (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    if (!p.isAdmin) return res.status(403).send(page("Admin", p, `<div class="card">Admins only.</div>`));
    const period = currentPeriod();
    const report = spendReport(db, cfg, period);
    const teams = new Map<string, { spend: number; limit: number; users: number }>();
    for (const row of report.rows) {
      const k = row.team ?? "(no team)";
      const t = teams.get(k) ?? { spend: 0, limit: 0, users: 0 };
      t.spend += row.spend_cents;
      t.limit += row.limit_cents;
      t.users++;
      teams.set(k, t);
    }
    const runs = db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 6").all() as {
      ts: string;
      connector: string;
      ok: number;
      message: string;
    }[];
    const unmatched = db
      .prepare("SELECT tool, COUNT(*) AS n, SUM(cents) AS c FROM unmatched_spend WHERE period = ? GROUP BY tool")
      .all(period) as { tool: string; n: number; c: number }[];
    const toolCols = report.tools;
    res.send(
      page(
        "Admin",
        p,
        `${flash(req)}${licenseCard(licenseStatus(db, cfg))}<h1>Spend for ${esc(period)}</h1>
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
  });

  r.post("/portal/sync", async (req, res) => {
    const p = signedIn(req, res);
    if (!p) return;
    if (!p.isAdmin || !csrfOk(req)) return res.status(403).send("Forbidden");
    const results = await sync.run();
    back(res, "/admin", results.map((x) => `${x.connector}: ${x.ok ? "ok" : "failed"}`).join("; ") || "No connectors configured.");
  });

  return r;
}
