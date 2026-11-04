import express, { type Request, type Response } from "express";
import { csrfOk, type Principal } from "../auth.js";
import type { Db } from "../db.js";
import { HttpError } from "../service.js";
import { fmtUsd } from "../wallet.js";
import { PROVIDER_LABELS } from "../providers/index.js";
import { validateSshKey, type Workspace, type WorkspaceService, type WorkspaceTemplate } from "../workspaces.js";
import { act, adminGuard, adminTabs, csrfField, esc, flash, options, page, wrap } from "./html.js";

const STATE_LABEL: Record<string, string> = {
  creating: "Creating",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  terminated: "Deleted",
  error: "Failed",
};

/** Hourly prices are kept to 4 decimals, like cloud price lists. */
const perHour = (e4: number) => `$${(e4 / 10_000).toFixed(4)}`;

const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "");

export function workspacesPortalRoutes(db: Db, ws: WorkspaceService) {
  const r = express.Router();
  r.use(["/workspaces", "/admin/workspaces"], express.urlencoded({ extended: false, limit: "64kb" }));

  /** Any signed-in person; POSTs need the CSRF token. */
  const member = (req: Request, res: Response): Principal | null => {
    const p = req.principal;
    if (!p?.user) {
      res.redirect("/");
      return null;
    }
    if (req.method === "POST" && !csrfOk(req)) {
      res.status(403).send(page("Workspaces", p, `<div class="card">Your session expired. Reload the page and try again.</div>`));
      return null;
    }
    return p;
  };

  const actions = (p: Principal, w: Workspace, base: string, extra = "") => {
    const btn = (action: string, label: string, ghost = false) =>
      `<form method="post" action="${base}/${w.id}/${action}" style="display:inline">${csrfField(p)}<button${ghost ? ' class="ghost"' : ""}>${label}</button></form>`;
    const out: string[] = [];
    if (w.state === "stopped" && !extra) out.push(btn("start", "Start"));
    if (w.state === "running" || w.state === "starting") {
      if (!extra) out.push(btn("extend", "Keep running 2 more hours", true));
      out.push(btn("stop", "Stop", true));
    }
    // Deleting destroys the disk, so it goes through a confirmation page (inline JS is blocked by the CSP).
    if (w.state !== "creating") out.push(`<a href="${base}/${w.id}/delete" style="align-self:center">Delete…</a>`);
    return `<div style="display:flex;gap:8px;flex-wrap:wrap">${out.join("")}</div>`;
  };

  // ------------------------------------------------------------------ developer page

  r.get(
    "/workspaces",
    wrap(async (req, res) => {
      const p = member(req, res);
      if (!p) return;
      const u = p.user!;
      if (!ws.enabled) {
        return res.send(page("Workspaces", p, `<h1>Workspaces</h1><div class="card"><p class="muted">Cloud workspaces aren't set up for your organization yet.</p></div>`));
      }
      const key = (await db.get<{ k: string | null }>("SELECT ssh_public_key AS k FROM users WHERE id = ?", u.id))?.k ?? null;
      const templates = await ws.templates(true);
      const mine = await ws.listFor(u.id);
      const costs = await ws.monthlyCosts(ws.currentPeriod());
      const tName = new Map(templates.map((t) => [t.id, t.name]));
      const cards = mine
        .map((w) => {
          const hint = ws.hintFor(w) ?? "";
          return `<div class="card"><h2>${esc(w.name)} <span class="badge">${STATE_LABEL[w.state] ?? esc(w.state)}</span></h2>
            <p class="muted">${esc(tName.get(w.template_id) ?? "")} · ${perHour(w.hourly_usd_e4)}/hour while running · ${w.disk_gb} GB disk
            ${w.stop_at && (w.state === "running" || w.state === "starting") ? `<br>Stops automatically at ${when(w.stop_at)}.` : ""}
            ${w.detail ? `<br>${esc(w.detail)}` : ""}</p>
            ${actions(p, w, "/workspaces")}
            ${hint ? `<details style="margin-top:10px"><summary>Connect with VS Code or SSH</summary><pre>${esc(hint)}</pre>
              <p class="muted">Then run <code>ssh devhub-${esc(w.name)}</code>, or in VS Code: Remote-SSH, Connect to Host, <code>devhub-${esc(w.name)}</code>. Claude Code is installed and uses your organization's policy.</p></details>` : ""}
          </div>`;
        })
        .join("");
      res.send(
        page(
          "Workspaces",
          p,
          `${flash(req)}<h1>Workspaces</h1>
          <p class="muted">Cloud machines for development. Running time and disk count toward your AI budget: ${fmtUsd(costs.get(u.id) ?? 0)} so far this month.</p>
          ${cards || `<div class="card"><p class="muted">You don't have a workspace yet.</p></div>`}
          <div class="card"><h2>New workspace</h2>
            ${
              !key
                ? `<p>Add your SSH public key below first.</p>`
                : templates.length
                  ? `<form method="post" action="/workspaces/new" class="row">${csrfField(p)}
                      <div><label>Name</label><input name="name" required pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]" placeholder="e.g. payments"></div>
                      <div><label>Template</label><select name="template_id">${options(
                        templates.map((t): [string, string] => [String(t.id), `${t.name} (${perHour(t.hourly_usd_e4)}/hour, stops after ${t.stop_after_hours}h)`]),
                        String(templates[0].id),
                      )}</select></div>
                      <div style="flex:0 0 auto;min-width:0"><button>Create</button></div></form>`
                  : `<p class="muted">Your admin hasn't set up any templates yet.</p>`
            }
          </div>
          <div class="card"><h2>SSH public key</h2>
            <form method="post" action="/workspaces/ssh-key">${csrfField(p)}
              <textarea name="ssh_public_key" rows="3" spellcheck="false" placeholder="ssh-ed25519 AAAA... you@laptop">${esc(key ?? "")}</textarea>
              <p class="muted">Paste the contents of <code>~/.ssh/id_ed25519.pub</code>. New workspaces use it; existing ones keep the key they were created with.</p>
              <p><button>Save key</button></p></form></div>`,
        ),
      );
    }),
  );

  r.post(
    "/workspaces/ssh-key",
    wrap(async (req, res) => {
      const p = member(req, res);
      if (!p) return;
      await act(res, "/workspaces", async () => {
        const key = validateSshKey(String(req.body.ssh_public_key ?? ""));
        await db.run("UPDATE users SET ssh_public_key = ? WHERE id = ?", key, p.user!.id);
        return "SSH key saved.";
      });
    }),
  );

  r.post(
    "/workspaces/new",
    wrap(async (req, res) => {
      const p = member(req, res);
      if (!p) return;
      await act(res, "/workspaces", async () => {
        const w = await ws.create(p.user!, Number(req.body.template_id), String(req.body.name ?? ""));
        return `Creating ${w.name}. It takes a few minutes to start and install tools.`;
      });
    }),
  );

  r.post(
    "/workspaces/:id/:action(start|stop|extend|delete)",
    wrap(async (req, res) => {
      const p = member(req, res);
      if (!p) return;
      await act(res, "/workspaces", async () => {
        const w = await ws.get(Number(req.params.id));
        if (w.user_id !== p.user!.id || w.state === "terminated") throw new HttpError(404, "Workspace not found.");
        switch (req.params.action) {
          case "start":
            await ws.start(p.user!, w);
            return `Starting ${w.name}.`;
          case "stop":
            await ws.stop(w, p.user!.email);
            return `Stopping ${w.name}. Its disk is kept.`;
          case "extend":
            return `${w.name} will now stop at ${when(await ws.extend(w, p.user!.email))}.`;
          default:
            await ws.destroy(w, p.user!.email);
            return `Deleted ${w.name}.`;
        }
      });
    }),
  );

  const confirmDelete = (p: Principal, w: Workspace, base: string, back: string) =>
    page(
      "Delete workspace",
      p,
      `<h1>Delete ${esc(w.name)}?</h1><div class="card"><p>This terminates the machine and deletes its disk, including any work that isn't pushed. It can't be undone.</p>
       <form method="post" action="${base}/${w.id}/delete">${csrfField(p)}<button>Delete ${esc(w.name)}</button> <a href="${back}">Cancel</a></form></div>`,
    );

  r.get(
    "/workspaces/:id/delete",
    wrap(async (req, res) => {
      const p = member(req, res);
      if (!p) return;
      const w = await db.get<Workspace>("SELECT * FROM workspaces WHERE id = ? AND user_id = ? AND state != 'terminated'", Number(req.params.id), p.user!.id);
      if (!w) return res.redirect("/workspaces");
      res.send(confirmDelete(p, w, "/workspaces", "/workspaces"));
    }),
  );

  r.get(
    "/admin/workspaces/:id/delete",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const w = await db.get<Workspace>("SELECT * FROM workspaces WHERE id = ? AND state != 'terminated'", Number(req.params.id));
      if (!w) return res.redirect("/admin/workspaces");
      res.send(confirmDelete(p, w, "/admin/workspaces", "/admin/workspaces"));
    }),
  );

  // ------------------------------------------------------------------ admin

  /** The fields each backend's template needs. */
  const machineFields = (kind: string, c: Record<string, unknown>) => {
    const v = (k: string, d = "") => esc(String(c[k] ?? d));
    const field = (name: string, label: string, value: string, extra = "") =>
      `<div><label>${label}</label><input name="${name}" value="${value}" ${extra}></div>`;
    switch (kind) {
      case "gcp":
        return [
          field("zone", "Zone", v("zone"), 'required placeholder="us-central1-a"'),
          field("machineType", "Machine type", v("machineType", "e2-standard-4"), "required"),
          field("image", "Image (Ubuntu or Debian)", v("image", "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"), "required"),
          field("subnetwork", "Subnetwork (no external IPs)", v("subnetwork"), 'required placeholder="regions/us-central1/subnetworks/dev"'),
          field("diskGb", "Disk (GB)", v("diskGb", "50"), 'type="number" min="10" max="2000" required'),
          field("serviceAccount", "VM service account (optional)", v("serviceAccount"), 'placeholder="devhub-ws@project.iam.gserviceaccount.com"'),
        ].join("");
      case "coder":
        return [
          field("template", "Coder template name", v("template"), "required"),
          field("organization", "Coder organization", v("organization", "default"), "required"),
          field("diskGb", "Disk (GB, for the cost estimate)", v("diskGb", "0"), 'type="number" min="0" max="2000"'),
        ].join("");
      default:
        return [
          field("imageId", "AMI (Ubuntu or Debian with the SSM agent)", v("imageId"), 'required placeholder="ami-0abc..."'),
          field("instanceType", "Instance type", v("instanceType", "t3.xlarge"), "required"),
          field("diskGb", "Disk (GB)", v("diskGb", "50"), 'type="number" min="8" max="2000" required'),
          field("subnetId", "Subnet (private)", v("subnetId"), 'required placeholder="subnet-..."'),
          field("securityGroupIds", "Security groups", esc(((c.securityGroupIds as string[]) ?? []).join(", ")), 'required placeholder="sg-..."'),
          field("instanceProfile", "Instance profile (with SSM access)", v("instanceProfile"), "required"),
        ].join("");
    }
  };

  const machineSummary = (t: WorkspaceTemplate) => {
    const c = JSON.parse(t.config) as Record<string, unknown>;
    const disk = Number(c.diskGb) ? ` · ${c.diskGb} GB` : "";
    if (t.provider === "gcp") return `${esc(c.machineType)} in ${esc(c.zone)}${disk}`;
    if (t.provider === "coder") return `Coder template ${esc(c.template)}${disk}`;
    return `${esc(c.instanceType)}${disk}`;
  };

  const templateForm = (p: Principal, action: string, t: WorkspaceTemplate | null, label: string, kind: string) => {
    const c = t ? (JSON.parse(t.config) as Record<string, unknown>) : {};
    return `<form method="post" action="${action}">${csrfField(p)}<input type="hidden" name="provider" value="${esc(kind)}">
      <div class="grid">
        <div><label>Name</label><input name="name" value="${esc(t?.name ?? "")}" required placeholder="Standard (4 vCPU, 16 GB)"></div>
        ${machineFields(kind, c)}
        <div><label>Price per running hour (USD)</label><input name="hourly_usd" type="number" min="0" step="0.0001" value="${t ? t.hourly_usd_e4 / 10_000 : ""}" required placeholder="0.1664"></div>
        <div><label>Disk price per GB-month (USD)</label><input name="storage_gb_month_usd" type="number" min="0" step="0.001" value="${t ? t.storage_gb_month_cents / 100 : "0.08"}"></div>
        <div><label>Stop automatically after (hours)</label><input name="stop_after_hours" type="number" min="1" max="24" value="${t?.stop_after_hours ?? 8}"></div>
        <div><label>Available</label><select name="enabled">${options([["1", "Yes"], ["0", "No (hidden from developers)"]], t ? String(t.enabled) : "1")}</select></div>
      </div>
      <p><button>${label}</button></p></form>`;
  };

  const CONFIG_FIELDS: Record<string, string[]> = {
    aws: ["imageId", "instanceType", "diskGb", "subnetId", "securityGroupIds", "instanceProfile"],
    gcp: ["zone", "machineType", "image", "subnetwork", "diskGb", "serviceAccount"],
    coder: ["template", "organization", "diskGb"],
  };

  const templateBody = (req: Request, kind: string) => ({
    provider: kind,
    name: req.body.name,
    hourly_usd: req.body.hourly_usd,
    storage_gb_month_usd: req.body.storage_gb_month_usd || 0.08,
    stop_after_hours: Number(req.body.stop_after_hours || 8),
    enabled: req.body.enabled !== "0",
    config: Object.fromEntries(
      (CONFIG_FIELDS[kind] ?? []).map((k) => [k, k === "diskGb" ? Number(req.body[k] || 0) : req.body[k]]),
    ),
  });

  r.get(
    "/admin/workspaces",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      if (!ws.enabled) {
        return res.send(
          page(
            "Workspaces",
            p,
            `<h1>Admin</h1>${adminTabs("/admin/workspaces")}<div class="card"><p>Workspaces aren't configured. Set up at least one backend: <code>DEVHUB_WORKSPACES_AWS_REGION</code> (AWS EC2), <code>DEVHUB_WORKSPACES_GCP_PROJECT</code> (Google Compute Engine), or <code>DEVHUB_WORKSPACES_CODER_URL</code> with <code>CODER_SESSION_TOKEN</code> (Coder). The README covers the permissions each needs.</p></div>`,
          ),
        );
      }
      const templates = await ws.templates();
      const all = await ws.listAll();
      const costs = await ws.monthlyCosts(ws.currentPeriod());
      const running = all.filter((w) => w.state === "running" || w.state === "starting");
      res.send(
        page(
          "Workspaces",
          p,
          `${flash(req)}<h1>Admin</h1>${adminTabs("/admin/workspaces")}
          <div class="card scroll"><h2>Workspaces (${running.length} running of ${all.length})</h2>
            <table><thead><tr><th>Person</th><th>Workspace</th><th>Template</th><th>State</th><th>Auto-stop</th><th class="n">Person's cost this month</th><th></th></tr></thead><tbody>
            ${
              all
                .map(
                  (w) => `<tr><td>${esc(w.email)}</td><td>${esc(w.name)}<div class="muted"><code>${esc(w.machine_id ?? "")}</code></div></td><td>${esc(w.template)}</td>
                  <td>${STATE_LABEL[w.state] ?? esc(w.state)}</td><td>${w.state === "running" || w.state === "starting" ? when(w.stop_at) : ""}</td>
                  <td class="n">${fmtUsd(costs.get(w.user_id) ?? 0)}</td><td>${actions(p, w, "/admin/workspaces", "admin")}</td></tr>`,
                )
                .join("") || `<tr><td colspan="7" class="muted">No workspaces.</td></tr>`
            }</tbody></table></div>
          <div class="card scroll"><h2>Templates</h2>
            <table><thead><tr><th>Name</th><th>Backend</th><th>Machine</th><th class="n">Per hour</th><th class="n">Auto-stop</th><th>Available</th></tr></thead><tbody>
            ${
              templates
                .map(
                  (t) => `<tr><td><a href="/admin/workspaces/templates/${t.id}">${esc(t.name)}</a></td>
                    <td>${esc(PROVIDER_LABELS[t.provider] ?? t.provider)}${ws.providers.has(t.provider) ? "" : ` <span class="badge">not configured</span>`}</td>
                    <td>${machineSummary(t)}</td>
                    <td class="n">${perHour(t.hourly_usd_e4)}</td><td class="n">${t.stop_after_hours}h</td><td>${t.enabled ? "Yes" : "No"}</td></tr>`,
                )
                .join("") || `<tr><td colspan="6" class="muted">No templates yet.</td></tr>`
            }</tbody></table></div>
          <div class="card"><h2>Add a template</h2>
            ${[...ws.providers.keys()]
              .map(
                (kind, i) => `<details${i === 0 ? " open" : ""} style="margin-bottom:12px"><summary><b>${esc(PROVIDER_LABELS[kind] ?? kind)}</b></summary>
                  ${templateForm(p, "/admin/workspaces/templates/new", null, `Add ${esc(PROVIDER_LABELS[kind] ?? kind)} template`, kind)}</details>`,
              )
              .join("")}
            <p class="muted">Use your on-demand price for the machine type and region. Dev Hub charges running hours and disk to each person's budget. Coder templates provision machines through Coder; give Dev Hub's price as your estimate of what one costs per hour.</p></div>`,
        ),
      );
    }),
  );

  r.post(
    "/admin/workspaces/templates/new",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      await act(res, "/admin/workspaces", async () => {
        const t = await ws.saveTemplate(null, templateBody(req, String(req.body.provider ?? "")), p.label);
        return `Added template ${t.name}.`;
      });
    }),
  );

  r.get(
    "/admin/workspaces/templates/:id",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const t = await db.get<WorkspaceTemplate>("SELECT * FROM workspace_templates WHERE id = ?", Number(req.params.id));
      if (!t) return res.status(404).send(page("Not found", p, `<div class="card">No such template. <a href="/admin/workspaces">Back</a></div>`));
      res.send(
        page(
          t.name,
          p,
          `${flash(req)}<h1>${esc(t.name)}</h1>${adminTabs("/admin/workspaces")}
          <div class="card"><p class="muted">${esc(PROVIDER_LABELS[t.provider] ?? t.provider)} template. The backend can't be changed; add a new template for another one.</p>
            ${templateForm(p, `/admin/workspaces/templates/${t.id}`, t, "Save", t.provider)}
            <p class="muted">Changes apply to new workspaces. Existing ones keep the machine and price they were created with.</p></div>`,
        ),
      );
    }),
  );

  r.post(
    "/admin/workspaces/templates/:id",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const id = Number(req.params.id);
      await act(res, `/admin/workspaces/templates/${id}`, async () => {
        const t = await db.get<WorkspaceTemplate>("SELECT provider FROM workspace_templates WHERE id = ?", id);
        if (!t) throw new HttpError(404, "Template not found.");
        await ws.saveTemplate(id, templateBody(req, t.provider), p.label);
        return "Saved.";
      });
    }),
  );

  r.post(
    "/admin/workspaces/:id/:action(stop|delete)",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      await act(res, "/admin/workspaces", async () => {
        const w = await ws.get(Number(req.params.id));
        if (req.params.action === "stop") {
          await ws.stop(w, p.label);
          return `Stopping ${w.name}.`;
        }
        await ws.destroy(w, p.label);
        return `Deleted ${w.name}.`;
      });
    }),
  );

  return r;
}
