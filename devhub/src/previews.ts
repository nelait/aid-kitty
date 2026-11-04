import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { audit, insertId, isUniqueViolation, type Db, type User } from "./db.js";
import { HttpError } from "./service.js";
import { heredoc, templateSetup, type Workspace, type WorkspaceService, type WorkspaceTemplate } from "./workspaces.js";

/**
 * Per-pull-request preview environments. For each configured repo, every open PR (optionally
 * only those with a label) gets a machine from a workspace template. The machine fetches the
 * PR's latest commit through Dev Hub (so no GitHub credentials go onto it), runs the repo's
 * build and start commands, and redeploys when new commits arrive. Dev Hub serves it at
 * https://pr-<n>-<repo>.<previews.domain>, behind Okta sign-in, by proxying to the machine's
 * private IP. Previews are removed when the PR closes, or after ttl_hours without a push.
 * The machine time is charged to the PR author's budget, like a workspace.
 */

export interface PreviewRepo {
  id: number;
  repo: string;
  template_id: number;
  port: number;
  build_command: string;
  start_command: string;
  ttl_hours: number;
  label: string;
  allow_forks: number;
  enabled: number;
}

export type PreviewState = "active" | "skipped" | "closed" | "expired" | "removed";

export interface Preview {
  id: number;
  repo_id: number;
  pr_number: number;
  slug: string;
  title: string;
  author_login: string;
  user_id: number | null;
  head_sha: string;
  workspace_id: number | null;
  state: PreviewState;
  /** Why it's skipped, or what removed it. */
  reason: string | null;
  /** Last commit the machine deployed successfully. */
  deploy_sha: string | null;
  /** The machine's last report: deploying, ok, failed-fetch, failed-build or failed-start. */
  deploy_status: string | null;
  deploy_log: string | null;
  comment_id: string | null;
  comment_hash: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Pull {
  number: number;
  title: string;
  user: { login: string } | null;
  head: { sha: string; repo: { full_name: string } | null };
  labels?: { name: string }[];
}

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DEPLOY_STATUSES = ["deploying", "ok", "failed-fetch", "failed-build", "failed-start"];
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A DNS label for a PR: pr-123-payments-api (at most 50 characters). */
export function previewSlug(repo: string, pr: number): string {
  const name = repo.split("/")[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `pr-${pr}-${name}`.slice(0, 50).replace(/-+$/, "");
}

/** The handful of GitHub REST calls previews need, with Dev Hub's GitHub token. */
export class GitHubClient {
  constructor(
    private apiUrl: string,
    private token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]}: HTTP ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Open PRs, newest first (up to 300). */
  async openPulls(repo: string): Promise<Pull[]> {
    const out: Pull[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.call<Pull[]>("GET", `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  /** The commit's source as a .tar.gz stream (GitHub redirects to its download host; fetch follows). */
  async tarball(repo: string, sha: string): Promise<Response> {
    const res = await fetch(`${this.apiUrl.replace(/\/$/, "")}/repos/${repo}/tarball/${sha}`, {
      headers: { authorization: `Bearer ${this.token}`, "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok || !res.body) throw new HttpError(502, `GitHub tarball for ${repo}@${sha.slice(0, 7)}: HTTP ${res.status}`);
    return res;
  }

  /** Creates the PR comment, or updates it if `id` is given. Returns its id. */
  async comment(repo: string, pr: number, body: string, id: string | null): Promise<string> {
    if (id) {
      try {
        await this.call("PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
        return id;
      } catch (e) {
        if (!/HTTP 404/.test((e as Error).message)) throw e; // deleted by someone: post a new one
      }
    }
    const c = await this.call<{ id: number }>("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
    return String(c.id);
  }
}

export class PreviewService {
  private keyCache: Buffer | null = null;
  /** The latest webhook-triggered reconcile (tests await it). */
  lastWebhook: Promise<unknown> = Promise.resolve();

  constructor(
    private db: Db,
    private cfg: Config,
    readonly workspaces: WorkspaceService,
    private github: GitHubClient | null,
    private now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return Boolean(this.cfg.previews && this.github && this.workspaces.enabled);
  }

  /** Why previews are off, for the admin page; null when they're on. */
  get disabledReason(): string | null {
    if (!this.cfg.previews) return "Set previews.domain (or DEVHUB_PREVIEW_DOMAIN) to a wildcard DNS name that points at Dev Hub.";
    if (!this.github) return "Set GITHUB_TOKEN (with GITHUB_ORG) so Dev Hub can read pull requests and their code.";
    if (!this.workspaces.enabled) return "Configure an AWS or GCP workspace backend; previews run on workspace machines.";
    return null;
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  url(p: Pick<Preview, "slug">): string {
    const base = new URL(this.cfg.publicUrl);
    return `${base.protocol}//${p.slug}.${this.cfg.previews!.domain}${base.port ? `:${base.port}` : ""}`;
  }

  // ------------------------------------------------------------------ repos

  repos(): Promise<PreviewRepo[]> {
    return this.db.all<PreviewRepo>("SELECT * FROM preview_repos ORDER BY repo");
  }

  async repo(id: number): Promise<PreviewRepo> {
    const r = await this.db.get<PreviewRepo>("SELECT * FROM preview_repos WHERE id = ?", id);
    if (!r) throw new HttpError(404, "repo not found");
    return r;
  }

  async saveRepo(id: number | null, b: Record<string, unknown>, actor: string): Promise<PreviewRepo> {
    const repo = String(b.repo ?? "").trim().toLowerCase();
    if (!REPO_RE.test(repo)) throw new HttpError(400, "repo must be owner/name, e.g. acme/payments");
    const templateId = Number(b.template_id);
    const t = await this.db.get<WorkspaceTemplate>("SELECT * FROM workspace_templates WHERE id = ?", templateId);
    if (!t) throw new HttpError(400, "template_id must be a workspace template");
    const provider = this.workspaces.providers.get(t.provider);
    if (!provider?.usesSetupScript || !provider.privateAddress) {
      throw new HttpError(400, "Previews need an AWS or GCP template (Dev Hub proxies to the machine's private IP).");
    }
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 22) throw new HttpError(400, "port must be the port the app listens on (1-65535, not 22)");
    const text = (k: string, max: number) => {
      const v = String(b[k] ?? "").replace(/\r\n?/g, "\n").trim();
      if (Buffer.byteLength(v) > max) throw new HttpError(400, `${k} can be at most ${max} bytes`);
      if (v.includes("\0")) throw new HttpError(400, `${k} must be text`);
      return v;
    };
    const build = text("build_command", 4096);
    const start = text("start_command", 4096);
    if (!start) throw new HttpError(400, "start_command is required, e.g. npm start");
    const ttl = Number(b.ttl_hours ?? 72);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 720) throw new HttpError(400, "ttl_hours must be a whole number from 1 to 720");
    const label = String(b.label ?? "").trim();
    if (label && !/^[\w .:/-]{1,50}$/.test(label)) throw new HttpError(400, "label must be a GitHub label name");
    const forks = b.allow_forks === true || b.allow_forks === "1" ? 1 : 0;
    const enabled = b.enabled === false || b.enabled === "0" ? 0 : 1;
    const values = [repo, templateId, port, build, start, ttl, label, forks, enabled] as const;
    try {
      if (id === null) {
        id = await insertId(
          this.db,
          "INSERT INTO preview_repos (repo, template_id, port, build_command, start_command, ttl_hours, label, allow_forks, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ...values,
        );
      } else {
        const r = await this.db.run(
          "UPDATE preview_repos SET repo = ?, template_id = ?, port = ?, build_command = ?, start_command = ?, ttl_hours = ?, label = ?, allow_forks = ?, enabled = ? WHERE id = ?",
          ...values,
          id,
        );
        if (r.changes === 0) throw new HttpError(404, "repo not found");
      }
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, `${repo} already has preview settings`);
      throw e;
    }
    // Build and start commands run on machines with the repo's code: keep each version.
    await audit(this.db, actor, "preview.repo.saved", { id, repo, templateId, port, build, start, ttl, label, allowForks: forks, enabled });
    return this.repo(id);
  }

  // ------------------------------------------------------------------ previews

  list(): Promise<(Preview & { repo: string; email: string | null; ws_state: string | null; port: number; ttl_hours: number })[]> {
    return this.db.all(
      `SELECT p.*, r.repo, r.port, r.ttl_hours, u.email, w.state AS ws_state FROM previews p
       JOIN preview_repos r ON r.id = p.repo_id LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN workspaces w ON w.id = p.workspace_id
       ORDER BY CASE WHEN p.state = 'active' THEN 0 WHEN p.state = 'skipped' THEN 1 ELSE 2 END, p.updated_at DESC`,
    );
  }

  async get(id: number): Promise<Preview> {
    const p = await this.db.get<Preview>("SELECT * FROM previews WHERE id = ?", id);
    if (!p) throw new HttpError(404, "preview not found");
    return p;
  }

  bySlug(slug: string) {
    return this.db.get<Preview & { repo: string; port: number; ttl_hours: number }>(
      "SELECT p.*, r.repo, r.port, r.ttl_hours FROM previews p JOIN preview_repos r ON r.id = p.repo_id WHERE p.slug = ?",
      slug,
    );
  }

  private async set(p: Preview, fields: Partial<Preview>) {
    const all = { ...fields, updated_at: this.iso() };
    const keys = Object.keys(all);
    await this.db.run(`UPDATE previews SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => ((all as Record<string, unknown>)[k] ?? null) as string | number | null), p.id);
    Object.assign(p, all);
  }

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Bring every enabled repo's previews in line with its open PRs. Runs one at a time in this
   * process (webhooks, the sync and admin saves can all ask at once).
   */
  reconcile(onlyRepo?: string): Promise<{ repos: number; errors: string[] }> {
    const next = this.queue.then(() => this.reconcileNow(onlyRepo));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async reconcileNow(onlyRepo?: string): Promise<{ repos: number; errors: string[] }> {
    const errors: string[] = [];
    if (!this.enabled) return { repos: 0, errors };
    const repos = (await this.repos()).filter((r) => (onlyRepo ? r.repo === onlyRepo.toLowerCase() : true));
    for (const r of repos) {
      try {
        await this.reconcileRepo(r);
      } catch (e) {
        errors.push(`${r.repo}: ${(e as Error).message}`);
      }
    }
    return { repos: repos.length, errors };
  }

  private async reconcileRepo(repo: PreviewRepo) {
    const existing = await this.db.all<Preview>("SELECT * FROM previews WHERE repo_id = ?", repo.id);
    const byPr = new Map(existing.map((p) => [Number(p.pr_number), p]));
    // A disabled repo keeps no previews running.
    // If GitHub can't be read, this throws before anything changes: never remove previews on a failed fetch.
    const pulls = repo.enabled ? await this.github!.openPulls(repo.repo) : [];
    const wanted = new Map<number, Pull>();
    for (const pr of pulls) {
      if (repo.label && !(pr.labels ?? []).some((l) => l.name === repo.label)) continue;
      wanted.set(pr.number, pr);
    }

    for (const p of existing) {
      if (!wanted.has(Number(p.pr_number)) && (p.state === "active" || p.state === "skipped")) {
        await this.remove(p, "closed", repo.enabled ? (repo.label ? "The PR was closed or lost its label." : "The PR was closed.") : "Previews were turned off for this repo.", repo);
      }
    }

    for (const pr of wanted.values()) {
      let p = byPr.get(pr.number);
      const author = (pr.user?.login ?? "").toLowerCase();
      if (!p) {
        let slug = previewSlug(repo.repo, pr.number);
        if (await this.db.get("SELECT 1 FROM previews WHERE slug = ?", slug)) slug = `${slug.slice(0, 44)}-r${repo.id}`;
        const now = this.iso();
        let id: number;
        try {
          id = await insertId(
            this.db,
            "INSERT INTO previews (repo_id, pr_number, slug, title, author_login, head_sha, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, ?)",
            repo.id,
            pr.number,
            slug,
            pr.title.slice(0, 200),
            author,
            pr.head.sha,
            now,
            now,
          );
        } catch (e) {
          // Another replica (handling a webhook) got there first; it sets this one up.
          if (isUniqueViolation(e)) continue;
          throw e;
        }
        p = await this.get(id);
        await this.ensure(p, repo, pr);
        continue;
      }
      const pushed = p.head_sha !== pr.head.sha;
      if (pushed || p.title !== pr.title.slice(0, 200)) await this.set(p, { head_sha: pr.head.sha, title: pr.title.slice(0, 200), author_login: author });
      // A new push brings back an expired or removed preview, and extends the expiry.
      if (pushed && p.state === "active") await this.set(p, { expires_at: this.iso(this.now() + repo.ttl_hours * 3_600_000) });
      if (p.state === "active" && p.expires_at && Date.parse(p.expires_at) <= this.now()) {
        await this.remove(p, "expired", `Removed after ${repo.ttl_hours} hours without a push.`, repo);
        continue;
      }
      if (p.state === "skipped" || p.state === "closed" || ((p.state === "expired" || p.state === "removed") && pushed)) {
        await this.ensure(p, repo, pr);
      } else if (p.state === "active") {
        await this.keepRunning(p, repo);
      }
    }
  }

  /** Create the machine for a preview, or record why not. */
  private async ensure(p: Preview, repo: PreviewRepo, pr: Pull) {
    const skip = async (reason: string) => {
      await this.set(p, { state: "skipped", reason });
      await this.comment(p, repo);
    };
    if (pr.head.repo?.full_name?.toLowerCase() !== repo.repo && !repo.allow_forks) {
      return skip("Previews don't run code from forks. Push the branch to this repository instead.");
    }
    const user = await this.db.get<User>("SELECT * FROM users WHERE github_login = ? AND status = 'active' AND deleted_at IS NULL", p.author_login);
    if (!user) return skip(`@${p.author_login} isn't linked to anyone in Dev Hub, so there's no budget to charge it to. An admin can set their GitHub login in Dev Hub.`);
    const max = this.cfg.previews?.maxActive ?? 20;
    const active = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM previews WHERE state = 'active'");
    if (Number(active?.n ?? 0) >= max) return skip(`Dev Hub's limit of ${max} previews running at once is reached. This preview starts when another one is removed.`);

    // Free any earlier machine (an expired or removed preview coming back).
    if (p.workspace_id) await this.destroyMachine(p);
    try {
      const ws = await this.workspaces.create(user, repo.template_id, `pv-${p.id}`, {
        userData: (token, t) => previewUserData(this.cfg, token, repo, t, user, this.url(p)),
      });
      await this.set(p, {
        state: "active",
        reason: null,
        user_id: user.id,
        workspace_id: ws.id,
        deploy_sha: null,
        deploy_status: null,
        deploy_log: null,
        expires_at: this.iso(this.now() + repo.ttl_hours * 3_600_000),
      });
      await audit(this.db, "system", "preview.created", { repo: repo.repo, pr: p.pr_number, workspace: ws.id, owner: user.email });
    } catch (e) {
      const status = (e as HttpError).status;
      return skip(status === 402 ? `@${p.author_login}'s AI budget for this month is used up.` : `The machine couldn't be created: ${(e as Error).message.slice(0, 200)}`);
    }
    await this.comment(p, repo);
  }

  /** An active preview whose machine was stopped (a used-up budget) starts again once there's budget. */
  private async keepRunning(p: Preview, repo: PreviewRepo) {
    const ws = p.workspace_id ? await this.db.get<Workspace>("SELECT * FROM workspaces WHERE id = ?", p.workspace_id) : null;
    if (!ws || ws.state === "terminated" || ws.state === "error") {
      // Deleted from the admin page or in the cloud console: stay down until the next push.
      await this.set(p, { state: "removed", reason: "Its machine was deleted. Push a commit to bring it back." });
      return this.comment(p, repo);
    }
    if (ws.state === "stopped") {
      const user = await this.db.get<User>("SELECT * FROM users WHERE id = ?", ws.user_id);
      try {
        if (user) await this.workspaces.start(user, ws, "system");
        await this.set(p, { reason: null });
      } catch {
        if (p.reason !== "budget") await this.set(p, { reason: "budget" });
      }
    }
    await this.comment(p, repo);
  }

  private async destroyMachine(p: Preview) {
    const ws = await this.db.get<Workspace>("SELECT * FROM workspaces WHERE id = ?", p.workspace_id);
    if (ws && ws.state !== "terminated" && ws.state !== "error") {
      try {
        await this.workspaces.destroy(ws, "system");
      } catch (e) {
        console.error(`removing preview machine ${ws.id} failed:`, (e as Error).message);
        throw e;
      }
    }
  }

  private async remove(p: Preview, state: "closed" | "expired" | "removed", reason: string, repo: PreviewRepo) {
    if (p.workspace_id) await this.destroyMachine(p);
    await this.set(p, { state, reason });
    await audit(this.db, "system", `preview.${state}`, { repo: repo.repo, pr: p.pr_number });
    await this.comment(p, repo);
  }

  /** Admin action: remove a preview now; it comes back on the next push. */
  async removeByAdmin(id: number, actor: string) {
    const p = await this.get(id);
    const repo = await this.repo(p.repo_id);
    if (p.workspace_id) await this.destroyMachine(p);
    await this.set(p, { state: "removed", reason: "Removed by an admin. Push a commit to bring it back." });
    await audit(this.db, actor, "preview.removed", { repo: repo.repo, pr: p.pr_number });
    await this.comment(p, repo);
  }

  /** One line on where a preview stands, for the admin page and the preview host's own status page. */
  async describe(p: Preview): Promise<string> {
    const sha = p.head_sha.slice(0, 7);
    switch (p.state) {
      case "skipped":
        return `No preview: ${p.reason}`;
      case "closed":
      case "expired":
      case "removed":
        return `Removed. ${p.reason ?? ""}`.trim();
    }
    const ws = p.workspace_id ? await this.db.get<Workspace>("SELECT state FROM workspaces WHERE id = ?", p.workspace_id) : null;
    if (ws?.state === "stopped" || ws?.state === "stopping") return `Stopped: @${p.author_login}'s AI budget for this month is used up.`;
    if (ws?.state === "creating" || ws?.state === "starting") return `Starting its machine, then deploying ${sha}.`;
    if (p.deploy_status === "ok" && p.deploy_sha === p.head_sha) return `Live: ${sha}.`;
    if (p.deploy_status?.startsWith("failed") && p.deploy_sha !== p.head_sha) {
      const what = { "failed-fetch": "download", "failed-build": "build", "failed-start": "start" }[p.deploy_status] ?? "deploy";
      return `${sha} failed to ${what}.`;
    }
    if (p.deploy_status === "deploying") return `Deploying ${sha}.`;
    return p.deploy_sha ? `Live: ${p.deploy_sha.slice(0, 7)}; ${sha} is on its way.` : `Waiting for its machine to deploy ${sha}.`;
  }

  // ------------------------------------------------------------------ PR comments

  /** What the PR comment says now. */
  private async commentBody(p: Preview, repo: PreviewRepo): Promise<string> {
    const sha = p.head_sha.slice(0, 7);
    const head = "**Preview environment**";
    const foot = `\n\n<sub>Managed by [Dev Hub](${this.cfg.publicUrl}/admin/previews).</sub>`;
    switch (p.state) {
      case "skipped":
        return `${head}: none for this PR. ${p.reason}${foot}`;
      case "closed":
      case "expired":
      case "removed":
        return `${head}: removed. ${p.reason}${p.state === "expired" ? " Push a commit to bring it back." : ""}${foot}`;
    }
    const ws = p.workspace_id ? await this.db.get<Workspace>("SELECT state FROM workspaces WHERE id = ?", p.workspace_id) : null;
    const url = this.url(p);
    const life = `Sign in with your company account to open it. Each push redeploys it. It's removed when this PR closes, or after ${repo.ttl_hours} hours without a push. Its machine time counts toward @${p.author_login}'s AI budget.`;
    if (ws?.state === "stopped" || ws?.state === "stopping") return `${head}: stopped because @${p.author_login}'s AI budget for this month is used up. It starts again when there's budget.${foot}`;
    if (p.deploy_status === "ok" && p.deploy_sha === p.head_sha) return `${head}: ${sha} is live at ${url}\n\n${life}${foot}`;
    if (p.deploy_status?.startsWith("failed") && p.deploy_sha !== p.head_sha) {
      const what = { "failed-fetch": "download", "failed-build": "build", "failed-start": "start" }[p.deploy_status] ?? "deploy";
      return `${head}: ${sha} failed to ${what}. The output is at ${url} (sign in with your company account). Push a fix to try again.${foot}`;
    }
    return `${head}: deploying ${sha}. It will be at ${url}\n\n${life}${foot}`;
  }

  /** Post or update the PR comment when what it says has changed. Failures are logged, not thrown. */
  private async comment(p: Preview, repo: PreviewRepo) {
    if (this.cfg.previews?.comment === false || !this.github) return;
    const body = await this.commentBody(p, repo);
    const hash = sha256(body);
    if (hash === p.comment_hash) return;
    try {
      const id = await this.github.comment(repo.repo, Number(p.pr_number), body, p.comment_id);
      await this.set(p, { comment_id: id, comment_hash: hash });
    } catch (e) {
      console.error(`preview comment on ${repo.repo}#${p.pr_number} failed:`, (e as Error).message);
    }
  }

  // ------------------------------------------------------------------ webhook

  /** Verifies a GitHub webhook and refreshes the repo it's about. Returns the HTTP status to answer with. */
  webhook(raw: Buffer, signature: string, event: string): number {
    const secret = this.cfg.previews?.webhookSecret;
    if (!secret) return 404;
    const want = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    if (signature.length !== want.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(want))) return 401;
    if (event === "ping") return 200;
    if (event !== "pull_request") return 202;
    let repo = "";
    try {
      repo = String((JSON.parse(raw.toString("utf8")) as { repository?: { full_name?: string } }).repository?.full_name ?? "");
    } catch {
      return 400;
    }
    // Answer GitHub straight away (it waits at most 10 seconds); creating machines can take longer.
    this.lastWebhook = this.reconcile(repo).catch((e) => console.error("preview webhook reconcile failed:", e));
    return 202;
  }

  // ------------------------------------------------------------------ machine API (agent token)

  private async forMachine(token: string) {
    const ws = await this.workspaces.byAgentToken(token);
    const p = await this.db.get<Preview>("SELECT * FROM previews WHERE workspace_id = ? AND state = 'active'", ws.id);
    if (!p) throw new HttpError(404, "no active preview for this machine");
    return { ws, p, repo: await this.repo(p.repo_id) };
  }

  /** The commit the machine should be running. */
  async target(token: string): Promise<string> {
    return (await this.forMachine(token)).p.head_sha;
  }

  /** Source of the commit the machine should be running, streamed from GitHub. */
  async source(token: string, sha: string): Promise<Response> {
    const { p, repo } = await this.forMachine(token);
    if (!SHA_RE.test(sha) || sha !== p.head_sha) throw new HttpError(404, "that commit isn't this preview's");
    return this.github!.tarball(repo.repo, sha);
  }

  /** The machine's deploy progress. */
  async status(token: string, sha: string, status: string, log: string) {
    const { p, repo } = await this.forMachine(token);
    if (!SHA_RE.test(sha) || !DEPLOY_STATUSES.includes(status)) throw new HttpError(400, "bad status report");
    if (sha !== p.head_sha) return; // superseded by a newer push; the machine will pick that up
    await this.set(p, { deploy_status: status, deploy_log: log.slice(-8000) || null, ...(status === "ok" ? { deploy_sha: sha } : {}) });
    if (status !== "deploying") await audit(this.db, "system", `preview.deploy.${status}`, { repo: repo.repo, pr: p.pr_number, sha });
    await this.comment(p, repo);
  }

  // ------------------------------------------------------------------ sign-in handoff for preview hosts

  private async key(): Promise<Buffer> {
    if (this.keyCache) return this.keyCache;
    await this.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES ('preview_signing_key', ?, ?) ON CONFLICT (key) DO NOTHING",
      randomBytes(32).toString("base64"),
      this.iso(),
    );
    const row = await this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'preview_signing_key'");
    this.keyCache = Buffer.from(row!.value, "base64");
    return this.keyCache;
  }

  /** A signed token for one preview host: "h" (2-minute handoff in a URL) or "c" (12-hour cookie). */
  async sign(kind: "h" | "c", userId: number, slug: string): Promise<string> {
    const exp = this.now() + (kind === "h" ? 120_000 : 12 * 3_600_000);
    const body = Buffer.from(JSON.stringify({ k: kind, u: userId, s: slug, e: exp })).toString("base64url");
    return `${body}.${createHmac("sha256", await this.key()).update(body).digest("base64url")}`;
  }

  /** The active person a token was issued to, or null. */
  async verify(kind: "h" | "c", token: string, slug: string): Promise<User | null> {
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const want = createHmac("sha256", await this.key()).update(body).digest("base64url");
    if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
    let t: { k: string; u: number; s: string; e: number };
    try {
      t = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (t.k !== kind || t.s !== slug || t.e <= this.now()) return null;
    const u = await this.db.get<User>("SELECT * FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL", t.u);
    return u ?? null;
  }

  /** The preview slug a Host header names, or null if it isn't a preview host. */
  slugForHost(host: string | undefined): string | null {
    const domain = this.cfg.previews?.domain;
    if (!domain || !host) return null;
    const h = host.toLowerCase().replace(/:\d+$/, "");
    if (!h.endsWith(`.${domain}`)) return null;
    const slug = h.slice(0, -domain.length - 1);
    return /^[a-z0-9-]{1,63}$/.test(slug) ? slug : null;
  }

  /** Where to send a request for this preview, if it's up. */
  async upstream(slug: string): Promise<{ preview: Preview & { repo: string; port: number; ttl_hours: number }; target: { host: string; port: number } | null }> {
    const preview = await this.bySlug(slug);
    if (!preview) throw new HttpError(404, "no such preview");
    const ws = preview.workspace_id ? await this.db.get<Workspace>("SELECT * FROM workspaces WHERE id = ?", preview.workspace_id) : null;
    const live = preview.state === "active" && ws?.state === "running" && ws.private_ip && preview.deploy_sha;
    return { preview, target: live ? { host: ws!.private_ip!, port: Number(preview.port) } : null };
  }
}

const DEPLOY_SCRIPT = `#!/bin/bash
# Dev Hub preview deployer. Every 30 seconds: ask Dev Hub which commit to run; if it's new,
# download it (through Dev Hub), build it, switch to it and restart the app.
set -uo pipefail
ETC=\${DEVHUB_ETC:-/etc/devhub}
ROOT=\${DEVHUB_PREVIEW_ROOT:-/srv/preview}
WAIT=\${DEVHUB_PREVIEW_WAIT:-60}
. "$ETC/agent.env"
. "$ETC/preview.env"
AUTH="authorization: Bearer $DEVHUB_AGENT_TOKEN"
TARGET=$(curl -fsS --max-time 20 -H "$AUTH" "$DEVHUB_URL/api/previews/target") || exit 0
case "$TARGET" in ''|*[!0-9a-f]*) exit 0 ;; esac
[ "$TARGET" = "$(cat "$ROOT/deployed" 2>/dev/null)" ] && exit 0
# One attempt per commit; a failed build waits for the next push.
[ "$TARGET" = "$(cat "$ROOT/attempted" 2>/dev/null)" ] && exit 0
echo "$TARGET" > "$ROOT/attempted"
LOG="$ROOT/build.log"
report() {
  tail -c 8000 "$LOG" > "$ROOT/report.log" 2>/dev/null || : > "$ROOT/report.log"
  curl -fsS --max-time 30 -X POST -H "$AUTH" -H "content-type: text/plain" --data-binary "@$ROOT/report.log" \\
    "$DEVHUB_URL/api/previews/status?sha=$TARGET&status=$1" > /dev/null || true
}
: > "$LOG"
report deploying
REL="$ROOT/releases/$TARGET"
rm -rf "$REL" && mkdir -p "$REL"
echo "Downloading $TARGET" >> "$LOG"
if ! curl -fsSL --max-time 600 -H "$AUTH" "$DEVHUB_URL/api/previews/source?sha=$TARGET" | tar -xz -C "$REL" --strip-components=1 >> "$LOG" 2>&1; then
  echo "Couldn't download the source." >> "$LOG"
  report failed-fetch
  exit 0
fi
chown -R preview:preview "$REL"
if [ -s "$ETC/preview-build.sh" ]; then
  echo "Building" >> "$LOG"
  if ! (cd "$REL" && runuser -u preview -- env HOME="$ROOT/home" PORT="$PORT" HOST="$HOST" DEVHUB_PREVIEW_URL="$DEVHUB_PREVIEW_URL" bash "$ETC/preview-build.sh") >> "$LOG" 2>&1; then
    echo "The build command failed." >> "$LOG"
    report failed-build
    exit 0
  fi
fi
ln -sfn "$REL" "$ROOT/current"
systemctl restart devhub-preview.service
for _ in $(seq 1 "$WAIT"); do
  code=$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    echo "$TARGET" > "$ROOT/deployed"
    for d in "$ROOT"/releases/*; do [ "$d" = "$REL" ] || rm -rf "$d"; done
    report ok
    exit 0
  fi
  sleep 2
done
journalctl -u devhub-preview.service -n 60 --no-pager >> "$LOG" 2>&1 || true
echo "The app didn't answer on port $PORT." >> "$LOG"
report failed-start
`;

export { DEPLOY_SCRIPT };

/** First-boot script for a preview machine: runtime, the template's script, the deployer and the app's service. */
export function previewUserData(cfg: Config, agentToken: string, repo: PreviewRepo, t: WorkspaceTemplate, owner: User, url: string): string {
  const env = [`PORT=${repo.port}`, "HOST=0.0.0.0", `DEVHUB_PREVIEW_URL=${url}`].join("\n");
  return `#!/bin/bash
# Dev Hub preview machine for ${repo.repo}. It deploys whichever commit Dev Hub names.
set -euo pipefail
[ -f /var/lib/devhub/setup-done ] && exit 0
install -d /etc/devhub /var/lib/devhub
umask 077
${heredoc("/etc/devhub/agent.env", `DEVHUB_URL=${cfg.publicUrl}\nDEVHUB_AGENT_TOKEN=${agentToken}`, "DEVHUB_AGENT_ENV")}
umask 022
${heredoc("/etc/devhub/preview.env", env, "DEVHUB_PREVIEW_ENV")}
${heredoc("/etc/devhub/preview-build.sh", repo.build_command ? `set -euo pipefail\n${repo.build_command}` : "", "DEVHUB_PREVIEW_BUILD")}
${heredoc("/etc/devhub/preview-start.sh", repo.start_command.includes("\n") ? repo.start_command : `exec ${repo.start_command}`, "DEVHUB_PREVIEW_START")}

export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl ca-certificates tar
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
id -u preview >/dev/null 2>&1 || useradd -r -m -d /srv/preview/home -s /bin/bash preview
install -d /srv/preview/releases
${templateSetup(t.setup_script ?? "", owner, `preview of ${repo.repo}`)}
${heredoc("/usr/local/bin/devhub-preview-deploy", DEPLOY_SCRIPT, "DEVHUB_DEPLOY")}
chmod 755 /usr/local/bin/devhub-preview-deploy
cat > /etc/systemd/system/devhub-preview.service <<'DEVHUB_UNIT'
[Unit]
Description=Pull request preview app
After=network-online.target
[Service]
User=preview
WorkingDirectory=/srv/preview/current
EnvironmentFile=/etc/devhub/preview.env
Environment=HOME=/srv/preview/home
ExecStart=/bin/bash /etc/devhub/preview-start.sh
Restart=on-failure
RestartSec=3
DEVHUB_UNIT
cat > /etc/systemd/system/devhub-preview-deploy.service <<'DEVHUB_UNIT'
[Unit]
Description=Deploy the latest commit of this preview
[Service]
Type=oneshot
ExecStart=/usr/local/bin/devhub-preview-deploy
DEVHUB_UNIT
cat > /etc/systemd/system/devhub-preview-deploy.timer <<'DEVHUB_UNIT'
[Unit]
Description=Check for new commits to preview every 30 seconds
[Timer]
OnBootSec=10s
OnUnitInactiveSec=30s
[Install]
WantedBy=timers.target
DEVHUB_UNIT
systemctl daemon-reload
systemctl enable devhub-preview.service
systemctl enable --now devhub-preview-deploy.timer
touch /var/lib/devhub/setup-done
`;
}
