import express, { type NextFunction, type Request, type Response } from "express";
import type { Principal } from "../auth.js";
import { installLicense, LINKABLE_TOOLS, linkIdentity, parseCsv, ROLES, saveTeam, upsertUsers } from "../admin.js";
import type { Config } from "../config.js";
import type { Db, Team, User } from "../db.js";
import { licenseStatus } from "../license.js";
import { HttpError } from "../service.js";
import type { SyncService } from "../sync.js";
import { currentPeriod, fmtUsd, walletFor } from "../wallet.js";
import { act, adminGuard, adminTabs, csrfField, esc, flash, options, page, wrap } from "./html.js";

/** An empty form field means "none / use the default". */
const blankToNull = (v: unknown) => (v === undefined || String(v).trim() === "" ? null : String(v).trim());
const usd = (cents: number | null) => (cents === null ? "" : String(cents / 100));

export function adminPortalRoutes(db: Db, cfg: Config, sync: SyncService) {
  const r = express.Router();
  r.use("/admin", express.urlencoded({ extended: false, limit: "512kb" }));

  const admin = adminGuard;

  const teamOptions = async (current: number | null) => {
    const teams = await db.all<{ id: number; name: string }>("SELECT id, name FROM teams ORDER BY name");
    const currentName = teams.find((t) => t.id === current)?.name ?? "";
    return options([["", "No team"], ...teams.map((t): [string, string] => [t.name, t.name])], currentName);
  };
  const roleOptions = (current: string) => options(ROLES.map((x): [string, string] => [x, x[0].toUpperCase() + x.slice(1)]), current);

  // ------------------------------------------------------------------ People

  r.get(
    "/admin/people",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      const q = String(req.query.q ?? "").trim().toLowerCase();
      const users = await db.all<User & { team_name: string | null }>(
        `SELECT u.*, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id
         WHERE u.deleted_at IS NULL ${q ? "AND (u.email LIKE ? OR lower(COALESCE(u.name, '')) LIKE ?)" : ""}
         ORDER BY u.status, u.email LIMIT 500`,
        ...(q ? [`%${q}%`, `%${q}%`] : []),
      );
      const rows = [];
      for (const u of users) {
        const w = await walletFor(db, cfg, u);
        const badges = [
          u.status === "disabled" ? `<span class="badge">disabled</span>` : "",
          u.role !== "member" ? `<span class="badge">${esc(u.role)}</span>` : "",
          u.scim_external_id ? `<span class="badge">Okta</span>` : "",
        ].join(" ");
        rows.push(`<tr><td><a href="/admin/people/${u.id}">${esc(u.email)}</a>${u.name ? `<div class="muted">${esc(u.name)}</div>` : ""}</td>
          <td>${esc(u.team_name ?? "")}</td><td>${badges}</td>
          <td class="n">${fmtUsd(w.spendCents)}</td>
          <td class="n">${fmtUsd(w.limitCents)}${u.monthly_budget_cents === null ? "" : ` <span class="badge">custom</span>`}</td></tr>`);
      }
      const license = await licenseStatus(db, cfg);
      res.send(
        page(
          "People",
          p,
          `${flash(req)}<h1>Admin</h1>${adminTabs("/admin/people")}
          <div class="card">
            <form method="get" class="row"><div><input name="q" value="${esc(q)}" placeholder="Search by email or name"></div>
              <div style="flex:0 0 auto;min-width:0"><button class="ghost">Search</button></div></form>
            <p class="muted">${license.metered ? `${license.activeUsers} active, each billed through ${esc(license.plan ?? "the marketplace")}` : `${license.activeUsers} active of ${license.seatLimit} allowed by the license`}. Spend is for ${esc(currentPeriod())}.</p>
            <div class="scroll"><table><thead><tr><th>Person</th><th>Team</th><th></th><th class="n">Spent</th><th class="n">Budget</th></tr></thead>
            <tbody>${rows.join("") || `<tr><td colspan="5" class="muted">No one found.</td></tr>`}</tbody></table></div>
            ${users.length === 500 ? `<p class="muted">Showing the first 500. Search to narrow it down.</p>` : ""}
          </div>
          <div class="card"><h2>Add a person</h2>
            <form method="post" action="/admin/people/new">${csrfField(p)}
              <div class="grid">
                <div><label>Email</label><input name="email" type="email" required></div>
                <div><label>Name</label><input name="name"></div>
                <div><label>Team</label><select name="team">${await teamOptions(null)}</select></div>
                <div><label>Role</label><select name="role">${roleOptions("member")}</select></div>
                <div><label>GitHub login</label><input name="github_login"></div>
                <div><label>Monthly budget (USD)</label><input name="monthly_budget_usd" type="number" min="0" step="1" placeholder="Team or org default"></div>
              </div>
              <p><button>Add person</button></p>
            </form>
            <p class="muted">With Okta SCIM set up, people are added automatically when they're assigned the app.</p>
          </div>
          <div class="card"><h2>Import from CSV</h2>
            <form method="post" action="/admin/people/import">${csrfField(p)}
              <label>Columns: email (required), name, team, role, status, github_login, claude_user_id, monthly_budget_usd. Empty cells leave a field unchanged.</label>
              <textarea name="csv" rows="6" required placeholder="email,name,team,github_login&#10;priya@acme.io,Priya Shah,platform,priya-gh"></textarea>
              <p><button>Import</button></p>
            </form>
          </div>`,
        ),
      );
    }),
  );

  r.post(
    "/admin/people/new",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      await act(res, "/admin/people", async () => {
        const email = String(req.body.email ?? "").trim().toLowerCase();
        if (await db.get("SELECT id FROM users WHERE email = ?", email)) {
          throw new HttpError(409, `${email} already exists. Search for them to edit.`);
        }
        await upsertUsers(
          db,
          cfg,
          sync,
          [
            {
              email,
              name: blankToNull(req.body.name),
              team: blankToNull(req.body.team),
              role: req.body.role,
              github_login: blankToNull(req.body.github_login),
              monthly_budget_usd: blankToNull(req.body.monthly_budget_usd),
            },
          ],
          p.label,
        );
        return `Added ${email}.`;
      });
    }),
  );

  r.post(
    "/admin/people/import",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      await act(res, "/admin/people", async () => {
        const rows = parseCsv(String(req.body.csv ?? ""));
        const saved = await upsertUsers(db, cfg, sync, rows, p.label);
        return `Imported ${saved.length} ${saved.length === 1 ? "person" : "people"}.`;
      });
    }),
  );

  r.get(
    "/admin/people/:id",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      const u = await db.get<User>("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", Number(req.params.id));
      if (!u) return res.status(404).send(page("Not found", p, `<div class="card">No such person. <a href="/admin/people">Back to people</a></div>`));
      const w = await walletFor(db, cfg, u);
      const tools = Object.entries(w.spendByTool).map(([t, c]) => `${esc(t)} ${fmtUsd(c)}`).join(" · ");
      const self = p.user?.id === u.id;
      res.send(
        page(
          u.email,
          p,
          `${flash(req)}<h1>${esc(u.name ?? u.email)}</h1>${adminTabs("/admin/people")}
          <div class="card"><h2>This month</h2>
            <p>${fmtUsd(w.spendCents)} spent of ${fmtUsd(w.limitCents)}${w.approvedRaisesCents ? ` (includes ${fmtUsd(w.approvedRaisesCents)} of approved increases)` : ""}. ${fmtUsd(w.remainingCents)} left.</p>
            ${tools ? `<p class="muted">${tools}</p>` : ""}
          </div>
          <div class="card"><h2>Details</h2>
            ${u.scim_external_id ? `<p class="muted">Managed by Okta: Okta updates name, email and active status on its next sync. Team, role, budget and tool identities are yours to set here.</p>` : ""}
            <form method="post" action="/admin/people/${u.id}">${csrfField(p)}
              <div class="grid">
                <div><label>Email</label><input value="${esc(u.email)}" disabled></div>
                <div><label>Name</label><input name="name" value="${esc(u.name ?? "")}"></div>
                <div><label>Team</label><select name="team">${await teamOptions(u.team_id)}</select></div>
                <div><label>Role</label><select name="role"${self ? " disabled" : ""}>${roleOptions(u.role)}</select></div>
                <div><label>Status</label><select name="status"${self ? " disabled" : ""}>${options([["active", "Active"], ["disabled", "Disabled"]], u.status)}</select></div>
                <div><label>Monthly budget (USD)</label><input name="monthly_budget_usd" type="number" min="0" step="1" value="${usd(u.monthly_budget_cents)}" placeholder="Team or org default"></div>
                <div><label>GitHub login</label><input name="github_login" value="${esc(u.github_login ?? "")}"></div>
                <div><label>Claude user ID</label><input name="claude_user_id" value="${esc(u.claude_user_id ?? "")}" placeholder="${u.oidc_sub ? "Uses their SSO identity" : ""}"></div>
              </div>
              ${self ? `<p class="muted">You can't change your own role or status.</p>` : ""}
              <p><button>Save</button> <a href="/admin/people">Cancel</a></p>
            </form>
          </div>`,
        ),
      );
    }),
  );

  r.post(
    "/admin/people/:id",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      const id = Number(req.params.id);
      await act(res, `/admin/people/${id}`, async () => {
        const u = await db.get<User>("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", id);
        if (!u) throw new HttpError(404, "person not found");
        const self = p.user?.id === u.id;
        // Never let an admin lock themselves out by demoting or disabling their own account.
        if (self && ((req.body.role && req.body.role !== u.role) || (req.body.status && req.body.status !== u.status))) {
          throw new HttpError(400, "You can't change your own role or status.");
        }
        await upsertUsers(
          db,
          cfg,
          sync,
          [
            {
              email: u.email,
              name: blankToNull(req.body.name),
              team: blankToNull(req.body.team),
              role: self ? undefined : req.body.role,
              status: self ? undefined : req.body.status,
              github_login: blankToNull(req.body.github_login),
              claude_user_id: blankToNull(req.body.claude_user_id),
              monthly_budget_usd: blankToNull(req.body.monthly_budget_usd),
            },
          ],
          p.label,
        );
        return "Saved.";
      });
    }),
  );

  // ------------------------------------------------------------------ Teams

  r.get(
    "/admin/teams",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      const period = currentPeriod();
      const teams = await db.all<Team & { members: number; spend: number }>(
        `SELECT t.*,
           (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.status = 'active') AS members,
           (SELECT COALESCE(SUM(s.cents), 0) FROM spend s JOIN users u ON u.id = s.user_id WHERE u.team_id = t.id AND s.period = ?) AS spend
         FROM teams t ORDER BY t.name`,
        period,
      );
      const rows = teams
        .map(
          (t) => `<tr><td><a href="/admin/teams/${t.id}">${esc(t.name)}</a>${t.scim_external_id ? ` <span class="badge">Okta</span>` : ""}</td>
          <td>${esc(t.cost_center ?? "")}</td><td class="n">${Number(t.members)}</td>
          <td class="n">${t.member_default_cents === null ? `<span class="muted">org default</span>` : fmtUsd(t.member_default_cents)}</td>
          <td class="n">${t.monthly_pool_cents === null ? `<span class="muted">none</span>` : fmtUsd(t.monthly_pool_cents)}</td>
          <td class="n">${fmtUsd(Number(t.spend))}</td></tr>`,
        )
        .join("");
      res.send(
        page(
          "Teams",
          p,
          `${flash(req)}<h1>Admin</h1>${adminTabs("/admin/teams")}
          <div class="card scroll"><table><thead><tr><th>Team</th><th>Cost center</th><th class="n">People</th>
            <th class="n">Per-person budget</th><th class="n">Team pool</th><th class="n">Spent (${esc(period)})</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6" class="muted">No teams yet.</td></tr>`}</tbody></table>
            <p class="muted">Org default budget: ${fmtUsd(Math.round(cfg.wallet.defaultMonthlyBudgetUsd * 100))} per person per month.</p></div>
          <div class="card"><h2>Add a team</h2>${teamForm(p, "/admin/teams/new", null, "Add team")}
            <p class="muted">Groups pushed from Okta become teams automatically.</p></div>`,
        ),
      );
    }),
  );

  const teamForm = (p: Principal, action: string, t: Team | null, label: string) => `
    <form method="post" action="${action}">${csrfField(p)}
      <div class="grid">
        <div><label>Name</label><input name="name" value="${esc(t?.name ?? "")}" required></div>
        <div><label>Cost center</label><input name="cost_center" value="${esc(t?.cost_center ?? "")}"></div>
        <div><label>Per-person monthly budget (USD)</label><input name="member_default_usd" type="number" min="0" step="1" value="${usd(t?.member_default_cents ?? null)}" placeholder="Org default"></div>
        <div><label>Shared team pool per month (USD)</label><input name="monthly_pool_usd" type="number" min="0" step="1" value="${usd(t?.monthly_pool_cents ?? null)}" placeholder="No pool"></div>
      </div>
      <p><button>${label}</button></p>
    </form>`;

  const teamBody = (req: Request) => ({
    name: blankToNull(req.body.name),
    cost_center: blankToNull(req.body.cost_center),
    member_default_usd: blankToNull(req.body.member_default_usd),
    monthly_pool_usd: blankToNull(req.body.monthly_pool_usd),
  });

  r.post(
    "/admin/teams/new",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      await act(res, "/admin/teams", async () => {
        await saveTeam(db, sync, null, teamBody(req), p.label);
        return `Added team ${String(req.body.name ?? "").trim()}.`;
      });
    }),
  );

  r.get(
    "/admin/teams/:id",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      const t = await db.get<Team>("SELECT * FROM teams WHERE id = ?", Number(req.params.id));
      if (!t) return res.status(404).send(page("Not found", p, `<div class="card">No such team. <a href="/admin/teams">Back to teams</a></div>`));
      const members = await db.all<User>("SELECT * FROM users WHERE team_id = ? AND deleted_at IS NULL ORDER BY email", t.id);
      const list = members
        .map((u) => `<li><a href="/admin/people/${u.id}">${esc(u.email)}</a>${u.status === "disabled" ? ` <span class="badge">disabled</span>` : ""}</li>`)
        .join("");
      res.send(
        page(
          t.name,
          p,
          `${flash(req)}<h1>${esc(t.name)}</h1>${adminTabs("/admin/teams")}
          <div class="card"><h2>Settings</h2>
            ${t.scim_external_id ? `<p class="muted">Pushed from Okta: Okta controls the name and members. Cost center and budgets are yours to set here.</p>` : ""}
            ${teamForm(p, `/admin/teams/${t.id}`, t, "Save")}
            <p class="muted">Leave a budget empty to use the org default; leave the pool empty for no shared cap.</p></div>
          <div class="card"><h2>${members.length} ${members.length === 1 ? "person" : "people"}</h2>
            ${list ? `<ul>${list}</ul>` : `<p class="muted">No one yet. Set a person's team on their page.</p>`}</div>`,
        ),
      );
    }),
  );

  r.post(
    "/admin/teams/:id",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      const id = Number(req.params.id);
      await act(res, `/admin/teams/${id}`, async () => {
        await saveTeam(db, sync, id, teamBody(req), p.label);
        return "Saved. Budgets for this team's people are updated.";
      });
    }),
  );

  // ------------------------------------------------------------------ Unmatched spend

  r.get(
    "/admin/unmatched",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      const period = currentPeriod();
      const rows = await db.all<{ tool: string; external_id: string; cents: number }>(
        "SELECT tool, external_id, cents FROM unmatched_spend WHERE period = ? ORDER BY cents DESC, tool, external_id",
        period,
      );
      const people = await db.all<{ id: number; email: string }>(
        "SELECT id, email FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY email",
      );
      const personOptions = options([["", "Choose a person"], ...people.map((u): [string, string] => [String(u.id), u.email])], "");
      const body = rows
        .map((x) => {
          const link = LINKABLE_TOOLS[x.tool];
          const action = link
            ? `<form method="post" action="/admin/unmatched/link" class="row">${csrfField(p)}
                 <input type="hidden" name="tool" value="${esc(x.tool)}"><input type="hidden" name="external_id" value="${esc(x.external_id)}">
                 <div><select name="user_id" required aria-label="Person">${personOptions}</select></div>
                 <div style="flex:0 0 auto;min-width:0"><button>Link</button></div></form>`
            : `<span class="muted">Matched by email. <a href="/admin/people">Add a person</a> with this email.</span>`;
          return `<tr><td>${esc(x.tool)}</td><td><code>${esc(x.external_id)}</code>${link ? `<div class="muted">${link.label}</div>` : ""}</td>
            <td class="n">${fmtUsd(Number(x.cents))}</td><td style="min-width:260px">${action}</td></tr>`;
        })
        .join("");
      res.send(
        page(
          "Unmatched spend",
          p,
          `${flash(req)}<h1>Admin</h1>${adminTabs("/admin/unmatched")}
          <div class="card"><p>Spend from accounts Dev Hub can't tie to anyone, for ${esc(period)}. It isn't in anyone's budget or the chargeback report until you link it.</p>
            <div class="scroll"><table><thead><tr><th>Tool</th><th>Account</th><th class="n">Spent</th><th>Link to</th></tr></thead>
            <tbody>${body || `<tr><td colspan="4" class="muted">Nothing unmatched. All spend is tied to someone.</td></tr>`}</tbody></table></div></div>`,
        ),
      );
    }),
  );

  r.post(
    "/admin/unmatched/link",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      await act(res, "/admin/unmatched", async () => {
        const userId = Number(req.body.user_id);
        if (!Number.isInteger(userId) || userId <= 0) throw new HttpError(400, "Choose a person.");
        const u = await linkIdentity(db, sync, String(req.body.tool ?? ""), String(req.body.external_id ?? ""), userId, p.label);
        return `Linked to ${u.email}. Their spend is updated.`;
      });
    }),
  );

  // ------------------------------------------------------------------ License

  r.get(
    "/admin/license",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      const l = await licenseStatus(db, cfg);
      const facts: [string, string][] = [
        ["Status", { valid: "Valid", grace: "Expired (grace period)", expired: "Expired", evaluation: "Evaluation", invalid: "Invalid" }[l.state]],
        ...(l.source && l.source !== "file" ? ([["Bought through", l.plan ?? "—"]] as [string, string][]) : []),
        ["Licensed to", l.customer ?? "—"],
        ["Seats", l.metered ? "No limit: billed for each active person" : `${l.seats} (up to ${l.seatLimit} with true-up)`],
        ["Active people", String(l.activeUsers)],
        ["Expires", l.expiresAt ? l.expiresAt.slice(0, 10) : "—"],
        ["License ID", l.licenseId ?? "—"],
      ];
      res.send(
        page(
          "License",
          p,
          `${flash(req)}<h1>Admin</h1>${adminTabs("/admin/license")}
          <div class="card"${l.state === "valid" && l.canActivate ? "" : ' style="border-color:var(--warn)"'}><p>${esc(l.message)}</p>
            <table><tbody>${facts.map(([k, v]) => `<tr><th style="width:180px">${k}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>
            <p class="muted">Budget enforcement keeps working whatever the license state; only adding people is limited.</p></div>
          ${
            l.source && l.source !== "file"
              ? `<div class="card"><h2>Subscription</h2><p class="muted">${
                  l.source === "aws-marketplace"
                    ? "Dev Hub checks the AWS License Manager license on every sync. To change the number of people, update the subscription in AWS Marketplace; Dev Hub picks it up within minutes."
                    : "Dev Hub reports the number of active people to Google Cloud Marketplace every hour through the metering agent next to it. Manage the subscription in the Google Cloud console."
                }</p></div>`
              : `<div class="card"><h2>Install a license</h2>
            <form method="post" action="/admin/license">${csrfField(p)}
              <label>Paste the contents of the license file from your vendor</label>
              <textarea name="license_file" rows="8" required placeholder='{"license": {...}, "signature": "..."}'></textarea>
              <p><button>Install</button></p>
            </form></div>`
          }`,
        ),
      );
    }),
  );

  r.post(
    "/admin/license",
    wrap(async (req, res) => {
      const p = admin(req, res);
      if (!p) return;
      await act(res, "/admin/license", async () => {
        await installLicense(db, String(req.body.license_file ?? "").trim(), p.label);
        return "License installed.";
      });
    }),
  );

  r.use("/admin", (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).send(page("Error", undefined, `<div class="card">Something went wrong. Try again.</div>`));
  });

  return r;
}
