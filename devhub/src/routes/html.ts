import type { NextFunction, Request, Response } from "express";
import { csrfOk, type Principal } from "../auth.js";
import { HttpError } from "../service.js";

/** Shared page shell and helpers for the server-rendered portal. Everything user-controlled goes through esc(). */

export const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

export const esc = (v: unknown) =>
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
select{font:inherit;width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 16px;border-bottom:1px solid var(--line)}
.tabs a{padding:8px 12px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a.on{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
.badge{display:inline-block;padding:0 6px;border-radius:4px;font-size:12px;border:1px solid var(--line);color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
td a{color:var(--accent)}
`;

export function page(title: string, p: Principal | undefined, body: string): string {
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

export const flash = (req: Request) => {
  const m = typeof req.query.msg === "string" ? req.query.msg : "";
  return m ? `<div class="flash">${esc(m)}</div>` : "";
};

export const back = (res: Response, path: string, msg: string) => res.redirect(`${path}?msg=${encodeURIComponent(msg)}`);

export const csrfField = (p: Principal) => `<input type="hidden" name="_csrf" value="${esc(p.csrf)}">`;

const ADMIN_TABS: [string, string][] = [
  ["/admin", "Overview"],
  ["/admin/people", "People"],
  ["/admin/teams", "Teams"],
  ["/admin/unmatched", "Unmatched spend"],
  ["/admin/policy", "Policy"],
  ["/admin/license", "License"],
];

export const adminTabs = (active: string) =>
  `<nav class="tabs">${ADMIN_TABS.map(([href, label]) => `<a href="${href}"${href === active ? ' class="on"' : ""}>${label}</a>`).join("")}</nav>`;

/** `<option>`s for a select, marking the current value. */
export const options = (items: [string, string][], current: string | null | undefined) =>
  items.map(([v, label]) => `<option value="${esc(v)}"${v === (current ?? "") ? " selected" : ""}>${esc(label)}</option>`).join("");

/** Admins only; every POST also needs the session's CSRF token. Sends the refusal itself and returns null. */
export function adminGuard(req: Request, res: Response): Principal | null {
  const p = req.principal;
  if (!p?.user) {
    res.redirect("/");
    return null;
  }
  if (!p.isAdmin) {
    res.status(403).send(page("Admin", p, `<div class="card">Admins only.</div>`));
    return null;
  }
  if (req.method === "POST" && !csrfOk(req)) {
    res.status(403).send(page("Admin", p, `<div class="card">Your session expired. Reload the page and try again.</div>`));
    return null;
  }
  return p;
}

/** Run a form action and redirect back with its outcome (or its validation error) as a message. */
export async function act(res: Response, to: string, fn: () => Promise<string>): Promise<void> {
  try {
    back(res, to, await fn());
  } catch (e) {
    if (e instanceof HttpError) return back(res, to, e.message);
    throw e;
  }
}
