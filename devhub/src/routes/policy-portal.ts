import express, { type Request } from "express";
import type { Principal } from "../auth.js";
import type { Config } from "../config.js";
import type { Db, Team } from "../db.js";
import {
  applyCopilotExclusions,
  claudeSettings,
  copilotExclusions,
  effective,
  EMPTY_TEAM_POLICY,
  gatewayManagedYaml,
  getOrgPolicy,
  getTeamPolicy,
  policyVersion,
  saveOrgPolicy,
  saveTeamPolicy,
  type OrgPolicy,
  type TeamPolicy,
} from "../policy.js";
import { HttpError } from "../service.js";
import { act, adminGuard, adminTabs, csrfField, esc, flash, page, wrap } from "./html.js";

/** One entry per line; blank lines ignored. */
const lines = (v: unknown) =>
  String(v ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
const joined = (v: string[] | null | undefined) => esc((v ?? []).join("\n"));

const textarea = (name: string, label: string, value: string, hint: string, rows = 4) =>
  `<div><label>${label}</label><textarea name="${name}" rows="${rows}" spellcheck="false">${value}</textarea>
   <div class="muted" style="font-size:13px">${hint}</div></div>`;

const checkbox = (name: string, label: string, on: boolean) =>
  `<label style="display:flex;gap:8px;align-items:center;color:var(--fg);font-size:15px"><input type="checkbox" name="${name}" value="1" style="width:auto"${on ? " checked" : ""}> ${label}</label>`;

const pre = (s: string) => `<pre style="max-height:320px">${esc(s)}</pre>`;

function teamSummary(t: TeamPolicy): string {
  const parts: string[] = [];
  if (t.allowedModels) parts.push(`models: ${t.allowedModels.join(", ") || "none"}`);
  if (t.protectedPaths.length) parts.push(`+${t.protectedPaths.length} protected paths`);
  if (t.deniedCommands.length) parts.push(`+${t.deniedCommands.length} blocked commands`);
  if (t.allowedMcpServers) parts.push(`MCP limited to ${t.allowedMcpServers.length}`);
  if (t.deniedMcpServers.length) parts.push(`+${t.deniedMcpServers.length} blocked MCP servers`);
  if (t.webAccess === false) parts.push("no web access");
  return parts.length ? esc(parts.join(" · ")) : `<span class="muted">Same as the org</span>`;
}

export function policyPortalRoutes(db: Db, cfg: Config) {
  const r = express.Router();
  r.use("/admin/policy", express.urlencoded({ extended: false, limit: "256kb" }));

  r.get(
    "/admin/policy",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const org = await getOrgPolicy(db);
      const teams = await db.all<Team>("SELECT * FROM teams ORDER BY name");
      const teamRows = [];
      for (const t of teams) {
        teamRows.push(`<tr><td><a href="/admin/policy/teams/${t.id}">${esc(t.name)}</a></td><td>${teamSummary(await getTeamPolicy(db, t.id))}</td></tr>`);
      }
      res.send(
        page(
          "Policy",
          p,
          `${flash(req)}<h1>Admin</h1>${adminTabs("/admin/policy")}
          <div class="card"><h2>Organization policy</h2>
            <p class="muted">Applies to everyone. Teams can add restrictions on top but can't loosen anything here. Version ${esc(await policyVersion(db))}.</p>
            ${orgForm(p, org)}</div>
          <div class="card scroll"><h2>Team rules</h2>
            <table><thead><tr><th>Team</th><th>Extra restrictions</th></tr></thead>
            <tbody>${teamRows.join("") || `<tr><td colspan="2" class="muted">No teams yet.</td></tr>`}</tbody></table></div>
          ${await rollout(db, cfg, p, org)}`,
        ),
      );
    }),
  );

  const orgForm = (p: Principal, o: OrgPolicy) => `
    <form method="post" action="/admin/policy">${csrfField(p)}
      <div class="grid">
        ${textarea("allowedModels", "Allowed Claude models", joined(o.allowedModels), "One per line, e.g. <code>sonnet</code> or <code>claude-opus-5-5</code>. Empty allows every model.")}
        ${textarea("protectedPaths", "Protected files", joined(o.protectedPaths), "AI tools can't read or edit these. gitignore patterns, e.g. <code>**/.env</code>, <code>secrets/**</code>.")}
        ${textarea("deniedCommands", "Blocked shell commands", joined(o.deniedCommands), "Claude Code won't run these. <code>*</code> is a wildcard, e.g. <code>rm -rf *</code>, <code>terraform apply *</code>.")}
        ${textarea("deniedMcpServers", "Blocked MCP servers", joined(o.deniedMcpServers), "Server names or URL patterns, always blocked.")}
      </div>
      <div class="grid" style="margin-top:12px">
        <div>${checkbox("mcpRestricted", "Only allow these MCP servers:", o.allowedMcpServers !== null)}
          <textarea name="allowedMcpServers" rows="3" spellcheck="false">${joined(o.allowedMcpServers)}</textarea>
          <div class="muted" style="font-size:13px">Unchecked: any server not blocked above. Checked and empty: no MCP servers at all.</div></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${checkbox("webAccess", "Allow web fetch and web search", o.webAccess)}
          ${checkbox("blockBypassPermissions", "Block bypass-permissions mode", o.blockBypassPermissions)}
        </div>
      </div>
      <details style="margin-top:12px"><summary>Advanced: extra Claude Code managed settings (JSON)</summary>
        <textarea name="extraClaudeSettings" rows="5" spellcheck="false">${esc(JSON.stringify(o.extraClaudeSettings, null, 2))}</textarea>
        <div class="muted" style="font-size:13px">Merged into Claude Code's managed settings as-is, e.g. <code>{"forceLoginMethod": "gateway"}</code>. Login-forcing keys are left out of the gateway block, as the gateway requires.</div>
      </details>
      <p><button>Save organization policy</button></p>
    </form>`;

  async function rollout(db: Db, cfg: Config, p: Principal, org: OrgPolicy) {
    let copilot = `<p class="muted">Connect GitHub (GITHUB_ORG and GITHUB_TOKEN) to push protected files to Copilot.</p>`;
    if (cfg.connectors.copilot) {
      let preview = "";
      try {
        const d = await applyCopilotExclusions(db, cfg, p.label, true);
        preview = d.changed
          ? `<p>Copilot's rules for all repositories (<code>"*"</code>) will change from:</p>${pre(JSON.stringify(d.current["*"] ?? [], null, 2))}<p>to:</p>${pre(JSON.stringify(d.next["*"] ?? [], null, 2))}
             <form method="post" action="/admin/policy/copilot">${csrfField(p)}<button>Apply to GitHub</button></form>`
          : `<p>Copilot already excludes exactly these paths in every repository.</p>`;
      } catch (e) {
        preview = `<p class="muted">Couldn't read Copilot's current rules: ${esc((e as Error).message)}</p>`;
      }
      copilot = `<p class="muted">Sets the organization's content exclusion rules for every repository to the protected files above.
        Rules someone set for individual repositories in GitHub are kept. GitHub's API drops comments in these rules. The organization owner's token needs the <code>copilot</code> scope.</p>${preview}`;
    }
    const cursorignore = org.protectedPaths.join("\n");
    return `<div class="card"><h2>Roll it out</h2>
      <h3 style="font-size:15px">Claude Code: live, through a policy helper (recommended)</h3>
      <p class="muted">Deploy once with your device management (MDM): developers' Claude Code then fetches this policy at startup and every 15 minutes, keeping the last copy if Dev Hub is unreachable. Team rules follow the person's git email. Teams can only tighten rules, so the worst a wrong email can do is fall back to the org policy.</p>
      <ol>
        <li><a href="/api/admin/policy/devhub-policy.sh">Download the helper</a>, install it as <code>/usr/local/bin/devhub-policy</code> (mode 755).</li>
        <li>Create <code>/etc/devhub/policy.env</code>: <pre>DEVHUB_URL=${esc(cfg.publicUrl)}\nDEVHUB_POLICY_TOKEN=&lt;the DEVHUB_POLICY_TOKEN value&gt;</pre></li>
        <li>Add to the machine's <code>managed-settings.json</code>: <pre>{ "policyHelper": { "path": "/usr/local/bin/devhub-policy", "timeoutMs": 5000, "refreshIntervalMs": 900000 } }</pre></li>
      </ol>
      ${cfg.policyToken ? "" : `<p><b>Set DEVHUB_POLICY_TOKEN on the server</b> before deploying the helper.</p>`}
      <p class="muted">What the org policy looks like to Claude Code (<a href="/api/admin/policy/claude-managed-settings.json">download as a static managed-settings.json</a> instead of the helper):</p>
      ${pre(JSON.stringify(claudeSettings(effective(org)), null, 2))}
      <h3 style="font-size:15px">Claude apps gateway</h3>
      <p class="muted">If developers sign in through the gateway, paste this into <code>gateway.yaml</code> and redeploy. The gateway matches team rules on the IdP group with the team's exact name, from the signed-in token. Clients pick up changes within an hour.</p>
      ${pre(await gatewayManagedYaml(db))}
      <p><a href="/api/admin/policy/gateway.yaml">Download gateway-managed.yaml</a></p>
      <h3 style="font-size:15px">GitHub Copilot: protected files</h3>
      ${copilot}
      <h3 style="font-size:15px">Cursor: not enforced</h3>
      <p class="muted">Cursor has no admin API for this. Committing a <code>.cursorignore</code> with the protected files to each repository asks Cursor not to read them, but developers can change it:</p>
      ${pre(cursorignore || "# no protected files")}
      <p class="muted">Copilot paths sent: ${esc(copilotExclusions(org).join(", ") || "none")}.</p>
    </div>`;
  }

  r.post(
    "/admin/policy",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      await act(res, "/admin/policy", async () => {
        let extra: unknown = {};
        const raw = String(req.body.extraClaudeSettings ?? "").trim();
        if (raw) {
          try {
            extra = JSON.parse(raw);
          } catch {
            throw new HttpError(400, "Extra Claude Code settings must be valid JSON.");
          }
        }
        await saveOrgPolicy(db, orgBody(req, extra), p.label);
        return "Organization policy saved. The live helper picks it up within 15 minutes; re-apply the gateway block and Copilot below if they changed.";
      });
    }),
  );

  const orgBody = (req: Request, extra: unknown) => ({
    allowedModels: lines(req.body.allowedModels),
    protectedPaths: lines(req.body.protectedPaths),
    deniedCommands: lines(req.body.deniedCommands),
    allowedMcpServers: req.body.mcpRestricted ? lines(req.body.allowedMcpServers) : null,
    deniedMcpServers: lines(req.body.deniedMcpServers),
    webAccess: req.body.webAccess === "1",
    blockBypassPermissions: req.body.blockBypassPermissions === "1",
    extraClaudeSettings: extra,
  });

  r.post(
    "/admin/policy/copilot",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      await act(res, "/admin/policy", async () => {
        const d = await applyCopilotExclusions(db, cfg, p.label, false);
        return d.changed ? "Copilot content exclusions updated." : "Copilot already matched the policy; nothing changed.";
      });
    }),
  );

  r.get(
    "/admin/policy/teams/:id",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const t = await db.get<Team>("SELECT * FROM teams WHERE id = ?", Number(req.params.id));
      if (!t) return res.status(404).send(page("Not found", p, `<div class="card">No such team. <a href="/admin/policy">Back to policy</a></div>`));
      const tp = await getTeamPolicy(db, t.id);
      const org = await getOrgPolicy(db);
      const eff = effective(org, { name: t.name, policy: tp });
      const tri = (v: boolean | null) => (v === false ? "off" : "inherit");
      res.send(
        page(
          `${t.name} policy`,
          p,
          `${flash(req)}<h1>${esc(t.name)}: extra restrictions</h1>${adminTabs("/admin/policy")}
          <div class="card">
            <p class="muted">Everything in the <a href="/admin/policy">organization policy</a> applies. Add more here; you can't loosen it.</p>
            <form method="post" action="/admin/policy/teams/${t.id}">${csrfField(p)}
              <div class="grid">
                ${textarea("allowedModels", "Allowed Claude models", joined(tp.allowedModels), `Empty: same as the org${org.allowedModels.length ? ` (${esc(org.allowedModels.join(", "))})` : " (any model)"}. Otherwise only these.`)}
                ${textarea("protectedPaths", "Extra protected files", joined(tp.protectedPaths), "Added to the org's list.")}
                ${textarea("deniedCommands", "Extra blocked shell commands", joined(tp.deniedCommands), "Added to the org's list.")}
                ${textarea("deniedMcpServers", "Extra blocked MCP servers", joined(tp.deniedMcpServers), "Added to the org's list.")}
              </div>
              <div class="grid" style="margin-top:12px">
                <div>${checkbox("mcpRestricted", "Only allow these MCP servers:", tp.allowedMcpServers !== null)}
                  <textarea name="allowedMcpServers" rows="3" spellcheck="false">${joined(tp.allowedMcpServers)}</textarea></div>
                <div><label>Web fetch and search</label>
                  <select name="webAccess"><option value="inherit"${tri(tp.webAccess) === "inherit" ? " selected" : ""}>Same as the org (${org.webAccess ? "allowed" : "off"})</option>
                  <option value="off"${tri(tp.webAccess) === "off" ? " selected" : ""}>Off for this team</option></select></div>
              </div>
              <p><button>Save team rules</button> <a href="/admin/policy">Cancel</a></p>
            </form>
          </div>
          <div class="card"><h2>What this team gets</h2>${pre(JSON.stringify(claudeSettings(eff), null, 2))}
            <p><a href="/api/admin/policy/claude-managed-settings.json?team=${t.id}">Download as managed-settings.json</a></p></div>`,
        ),
      );
    }),
  );

  r.post(
    "/admin/policy/teams/:id",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const id = Number(req.params.id);
      await act(res, `/admin/policy/teams/${id}`, async () => {
        const models = lines(req.body.allowedModels);
        await saveTeamPolicy(
          db,
          id,
          {
            ...EMPTY_TEAM_POLICY,
            allowedModels: models.length ? models : null,
            protectedPaths: lines(req.body.protectedPaths),
            deniedCommands: lines(req.body.deniedCommands),
            allowedMcpServers: req.body.mcpRestricted ? lines(req.body.allowedMcpServers) : null,
            deniedMcpServers: lines(req.body.deniedMcpServers),
            webAccess: req.body.webAccess === "off" ? false : null,
          },
          p.label,
        );
        return "Team rules saved.";
      });
    }),
  );

  return r;
}
