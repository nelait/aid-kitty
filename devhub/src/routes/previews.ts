import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { User } from "../db.js";
import type { PreviewService } from "../previews.js";
import { HttpError } from "../service.js";
import { act, adminGuard, adminTabs, csrfField, esc, flash, options, page, wrap } from "./html.js";

const COOKIE = "devhub_preview";

const cookieValue = (header: string | undefined, name: string) => {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
};

const safePath = (v: unknown) => (typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/");
const bearer = (req: Request) => /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1] ?? "";

/** Headers sent on to the preview app: our cookie removed, who's asking added (and never taken from the client). */
function forwardHeaders(req: IncomingMessage, user: User, proto: string): OutgoingHttpHeaders {
  const h: OutgoingHttpHeaders = { ...req.headers };
  const rest = (req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${COOKIE}=`))
    .join("; ");
  if (rest) h.cookie = rest;
  else delete h.cookie;
  h["x-forwarded-email"] = user.email;
  h["x-forwarded-user"] = user.name ?? user.email;
  h["x-forwarded-for"] = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
  h["x-forwarded-proto"] = proto;
  h["x-forwarded-host"] = req.headers.host;
  return h;
}

/** A small page served on the preview host itself while there's no app to proxy to. */
function statusPage(res: Response, code: number, title: string, body: string, refresh: boolean) {
  res
    .status(code)
    .set({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "referrer-policy": "no-referrer",
    })
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="10">' : ""}<title>${esc(title)}</title>
      <style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 16px;color:#1d1d1b;background:#f7f7f5}pre{background:#fff;border:1px solid #e4e3de;padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap}.m{color:#6b6b66}
      @media (prefers-color-scheme:dark){body{color:#ecebe6;background:#161615}pre{background:#1f1f1d;border-color:#34332f}.m{color:#a3a29b}}</style></head>
      <body><h1>${esc(title)}</h1>${body}</body></html>`,
    );
}

/**
 * Requests to <slug>.<previews.domain>: sign-in handoff, then proxying to the preview machine.
 * Mounted before everything else, so Dev Hub's own headers and sessions don't apply to previews.
 */
export function previewProxy(svc: PreviewService, cfg: Config) {
  const proto = () => new URL(cfg.publicUrl).protocol.replace(":", "");
  return (req: Request, res: Response, next: NextFunction) => {
    const slug = svc.slugForHost(req.headers.host);
    if (!slug) return next();
    (async () => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/__devhub/auth") {
        const user = await svc.verify("h", url.searchParams.get("t") ?? "", slug);
        if (!user) return statusPage(res, 403, "Sign-in link expired", `<p>Go back to the preview link and try again.</p>`, false);
        const secure = proto() === "https" ? "; Secure" : "";
        res.setHeader("set-cookie", `${COOKIE}=${await svc.sign("c", user.id, slug)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`);
        res.setHeader("referrer-policy", "no-referrer");
        return res.redirect(safePath(url.searchParams.get("next")));
      }
      const user = await svc.verify("c", cookieValue(req.headers.cookie, COOKIE), slug);
      if (!user) {
        // Only page loads get sent to sign in; an API call or asset gets a plain 401.
        if (req.method !== "GET" || !(req.headers.accept ?? "").includes("text/html")) return res.status(401).type("text/plain").send("Sign in to Dev Hub to see this preview.");
        return res.redirect(`${cfg.publicUrl}/previews/auth?slug=${encodeURIComponent(slug)}&next=${encodeURIComponent(req.url)}`);
      }
      let up;
      try {
        up = await svc.upstream(slug);
      } catch {
        return statusPage(res, 404, "No such preview", `<p class="m">There's no preview at this address.</p>`, false);
      }
      const { preview, target } = up;
      if (!target) {
        const status = await svc.describe(preview);
        const failed = preview.deploy_status?.startsWith("failed") && preview.deploy_sha !== preview.head_sha;
        const working = preview.state === "active" && !failed && !/stopped/i.test(status);
        return statusPage(
          res,
          503,
          `${preview.repo} #${preview.pr_number}`,
          `<p>${esc(status)}</p><p class="m">${esc(preview.title)}</p>${working ? `<p class="m">This page refreshes by itself.</p>` : ""}${
            preview.deploy_log && preview.state === "active" ? `<h2>Output</h2><pre>${esc(preview.deploy_log)}</pre>` : ""
          }`,
          working,
        );
      }
      const upstream = httpRequest(
        { host: target.host, port: target.port, method: req.method, path: req.url, headers: forwardHeaders(req, user, proto()) },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      upstream.setTimeout(120_000, () => upstream.destroy(new Error("timed out")));
      upstream.on("error", () => {
        if (!res.headersSent) statusPage(res, 502, `${preview.repo} #${preview.pr_number}`, `<p>The app isn't answering on port ${target.port}. It may be restarting.</p>`, true);
        else res.destroy();
      });
      req.pipe(upstream);
    })().catch(next);
  };
}

/** WebSocket (and other Upgrade) requests to preview hosts, e.g. a dev server's live reload. */
export function previewUpgrade(svc: PreviewService, cfg: Config) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    (async () => {
      const slug = svc.slugForHost(req.headers.host);
      if (!slug) return socket.destroy();
      const user = await svc.verify("c", cookieValue(req.headers.cookie, COOKIE), slug);
      if (!user) return socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
      const { target } = await svc.upstream(slug).catch(() => ({ target: null }));
      if (!target) return socket.end("HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n");
      const upstream = connect(target.port, target.host, () => {
        let out = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(forwardHeaders(req, user, new URL(cfg.publicUrl).protocol.replace(":", "")))) {
          for (const x of [v].flat()) if (x !== undefined) out += `${k}: ${x}\r\n`;
        }
        upstream.write(`${out}\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      // When either side goes away, close the other: upgraded sockets aren't tracked by the HTTP server.
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    })().catch(() => socket.destroy());
  };
}

/** Dev Hub-host routes: sign-in handoff, GitHub webhook, the machines' API, and the admin pages. */
export function previewRoutes(svc: PreviewService, cfg: Config) {
  const r = express.Router();

  // Signed in to Dev Hub: hand a short-lived token to the preview host, which turns it into its own cookie.
  r.get(
    "/previews/auth",
    wrap(async (req, res) => {
      if (!svc.enabled) return res.status(404).send("Previews aren't set up.");
      if (!req.principal?.user) {
        return res.redirect(cfg.auth.oidc ? `/auth/login?return_to=${encodeURIComponent(req.originalUrl)}` : "/");
      }
      const p = await svc.bySlug(String(req.query.slug ?? ""));
      if (!p) return res.status(404).send("No such preview.");
      const t = await svc.sign("h", req.principal.user.id, p.slug);
      res.redirect(`${svc.url(p)}/__devhub/auth?t=${encodeURIComponent(t)}&next=${encodeURIComponent(safePath(req.query.next))}`);
    }),
  );

  r.post(
    "/api/previews/webhook",
    express.raw({ type: "*/*", limit: "5mb" }),
    (req, res) => {
      const code = svc.webhook(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.get("x-hub-signature-256") ?? "", req.get("x-github-event") ?? "");
      res.status(code).json({ ok: code < 300 });
    },
  );

  // The preview machine's deployer, authenticated by its own agent token.
  r.get(
    "/api/previews/target",
    wrap(async (req, res) => res.type("text/plain").send(await svc.target(bearer(req)))),
  );
  r.get(
    "/api/previews/source",
    wrap(async (req, res) => {
      const gh = await svc.source(bearer(req), String(req.query.sha ?? ""));
      res.type("application/gzip");
      Readable.fromWeb(gh.body as import("node:stream/web").ReadableStream).pipe(res);
    }),
  );
  r.post(
    "/api/previews/status",
    express.text({ type: "*/*", limit: "64kb" }),
    wrap(async (req, res) => {
      await svc.status(bearer(req), String(req.query.sha ?? ""), String(req.query.status ?? ""), typeof req.body === "string" ? req.body : "");
      res.json({ ok: true });
    }),
  );

  // ---- Admin pages
  r.use("/admin/previews", express.urlencoded({ extended: false, limit: "64kb" }));

  const repoForm = async (p: NonNullable<Request["principal"]>, action: string, repo: Awaited<ReturnType<PreviewService["repo"]>> | null, label: string) => {
    const templates = (await svc.workspaces.templates()).filter((t) => svc.workspaces.providers.get(t.provider)?.privateAddress);
    if (!templates.length) return `<p class="muted">Add an AWS or GCP workspace template first; previews run on its machines.</p>`;
    return `<form method="post" action="${action}">${csrfField(p)}
      <div class="grid">
        <div><label>Repository</label><input name="repo" value="${esc(repo?.repo ?? "")}" required placeholder="acme/payments"></div>
        <div><label>Machine template</label><select name="template_id">${options(templates.map((t) => [String(t.id), t.name]), repo ? String(repo.template_id) : String(templates[0].id))}</select></div>
        <div><label>App port</label><input name="port" type="number" min="1" max="65535" value="${repo?.port ?? 3000}" required></div>
        <div><label>Remove after (hours without a push)</label><input name="ttl_hours" type="number" min="1" max="720" value="${repo?.ttl_hours ?? 72}"></div>
        <div><label>Only PRs with label (blank = every PR)</label><input name="label" value="${esc(repo?.label ?? "")}" placeholder="preview"></div>
        <div><label>PRs from forks</label><select name="allow_forks">${options([["0", "No preview"], ["1", "Preview them too"]], repo ? String(repo.allow_forks) : "0")}</select></div>
        <div><label>On</label><select name="enabled">${options([["1", "Yes"], ["0", "No (removes its previews)"]], repo ? String(repo.enabled) : "1")}</select></div>
      </div>
      <label>Build command (runs in the checkout as the <code>preview</code> user)</label>
      <textarea name="build_command" rows="3" spellcheck="false" style="font-family:ui-monospace,monospace" placeholder="npm ci && npm run build">${esc(repo?.build_command ?? "")}</textarea>
      <label>Start command (must listen on <code>$PORT</code> on all interfaces, <code>$HOST</code> is 0.0.0.0)</label>
      <textarea name="start_command" rows="2" spellcheck="false" style="font-family:ui-monospace,monospace" required placeholder="npm start">${esc(repo?.start_command ?? "")}</textarea>
      <p class="muted">The template's setup script runs first, so install runtimes there (Node.js 22 is already installed). <code>DEVHUB_PREVIEW_URL</code> holds the preview's address.</p>
      <p><button>${label}</button></p></form>`;
  };

  const repoBody = (req: Request) => ({
    repo: req.body.repo,
    template_id: req.body.template_id,
    port: req.body.port,
    ttl_hours: req.body.ttl_hours,
    label: req.body.label,
    allow_forks: req.body.allow_forks,
    enabled: req.body.enabled,
    build_command: req.body.build_command,
    start_command: req.body.start_command,
  });

  const githubWeb = () => {
    const api = cfg.connectors.copilot?.apiUrl ?? "https://api.github.com";
    return /api\.github\.com/.test(api) ? "https://github.com" : api.replace(/\/api\/v3\/?$/, "");
  };

  r.get(
    "/admin/previews",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      if (!svc.enabled) {
        return res.send(page("Previews", p, `<h1>Admin</h1>${adminTabs("/admin/previews")}<div class="card"><h2>Preview environments aren't set up</h2><p>${esc(svc.disabledReason)}</p><p class="muted">The README's "Preview environments" section has the steps.</p></div>`));
      }
      const repos = await svc.repos();
      const previews = await svc.list();
      const tpl = new Map((await svc.workspaces.templates()).map((t) => [t.id, t.name]));
      const rows = [];
      for (const v of previews) {
        rows.push(`<tr><td><a href="${esc(githubWeb())}/${esc(v.repo)}/pull/${v.pr_number}">${esc(v.repo)}#${v.pr_number}</a><div class="muted">${esc(v.title)}</div></td>
          <td>@${esc(v.author_login)}${v.email ? `<div class="muted">${esc(v.email)}</div>` : ""}</td>
          <td>${esc(await svc.describe(v))}</td>
          <td>${v.state === "active" ? `<a href="${esc(svc.url(v))}">${esc(v.slug)}</a>` : ""}</td>
          <td>${v.state === "active" && v.expires_at ? `${esc(v.expires_at.slice(0, 16).replace("T", " "))} UTC` : ""}</td>
          <td>${v.state === "active" ? `<form method="post" action="/admin/previews/${v.id}/remove">${csrfField(p)}<button class="ghost">Remove</button></form>` : ""}</td></tr>`);
      }
      res.send(
        page(
          "Previews",
          p,
          `${flash(req)}<h1>Admin</h1>${adminTabs("/admin/previews")}
          <div class="card scroll"><h2>Previews</h2>
            <table><thead><tr><th>Pull request</th><th>Author</th><th>Status</th><th>Link</th><th>Removed after</th><th></th></tr></thead><tbody>
            ${rows.join("") || `<tr><td colspan="6" class="muted">No previews yet. They appear when PRs are opened in the repos below.</td></tr>`}</tbody></table></div>
          <div class="card scroll"><h2>Repositories</h2>
            <table><thead><tr><th>Repository</th><th>Template</th><th class="n">Port</th><th>Label</th><th class="n">Removed after</th><th>On</th></tr></thead><tbody>
            ${
              repos
                .map(
                  (x) => `<tr><td><a href="/admin/previews/repos/${x.id}">${esc(x.repo)}</a></td><td>${esc(tpl.get(x.template_id) ?? "")}</td><td class="n">${x.port}</td>
                  <td>${x.label ? esc(x.label) : `<span class="muted">every PR</span>`}</td><td class="n">${x.ttl_hours}h</td><td>${x.enabled ? "Yes" : "No"}</td></tr>`,
                )
                .join("") || `<tr><td colspan="6" class="muted">No repositories yet.</td></tr>`
            }</tbody></table>
            <details style="margin-top:12px"><summary>Add a repository</summary>${await repoForm(p, "/admin/previews/repos/new", null, "Add")}</details></div>
          <div class="card"><h2>Setup</h2>
            <p>Previews are served at <code>https://pr-&lt;number&gt;-&lt;repo&gt;.${esc(cfg.previews!.domain)}</code>. Point <code>*.${esc(cfg.previews!.domain)}</code> at Dev Hub with a wildcard certificate.</p>
            <p>${
              cfg.previews!.webhookSecret
                ? `In each repository (or the organization), add a webhook to <code>${esc(cfg.publicUrl)}/api/previews/webhook</code> with content type <code>application/json</code>, your <code>DEVHUB_PREVIEW_WEBHOOK_SECRET</code>, and the "Pull requests" event. Without it, previews still update on each sync.`
                : `Previews update on each sync. For immediate updates, set <code>DEVHUB_PREVIEW_WEBHOOK_SECRET</code> and add a GitHub webhook to <code>${esc(cfg.publicUrl)}/api/previews/webhook</code>.`
            }</p></div>`,
        ),
      );
    }),
  );

  r.post(
    "/admin/previews/repos/new",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      await act(res, "/admin/previews", async () => {
        const x = await svc.saveRepo(null, repoBody(req), p.label);
        void svc.reconcile(x.repo).catch((e) => console.error("preview reconcile failed:", e));
        return `Previews are on for ${x.repo}. Open PRs get one within a minute.`;
      });
    }),
  );

  r.get(
    "/admin/previews/repos/:id",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const x = await svc.repo(Number(req.params.id));
      res.send(page("Previews", p, `${flash(req)}<h1>Admin</h1>${adminTabs("/admin/previews")}<div class="card"><h2>${esc(x.repo)}</h2>${await repoForm(p, `/admin/previews/repos/${x.id}`, x, "Save")}<p><a href="/admin/previews">Back</a></p></div>`));
    }),
  );

  r.post(
    "/admin/previews/repos/:id",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const id = Number(req.params.id);
      await act(res, `/admin/previews/repos/${id}`, async () => {
        const x = await svc.saveRepo(id, repoBody(req), p.label);
        await svc.reconcile(x.repo);
        return `Saved. Running previews pick up command changes when they're next recreated; new PRs use them now.`;
      });
    }),
  );

  r.post(
    "/admin/previews/:id/remove",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      await act(res, "/admin/previews", async () => {
        await svc.removeByAdmin(Number(req.params.id), p.label);
        return "Removed. It comes back if the PR gets a new push.";
      });
    }),
  );

  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof HttpError && res.req.path.startsWith("/api/previews/")) return res.status(err.status).json({ error: err.message });
    next(err);
  });

  return r;
}
