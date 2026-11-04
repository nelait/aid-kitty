import type { Config } from "./config.js";
import type { Connector, SpendRow } from "./connectors/types.js";
import { audit, insertId, isUniqueViolation, type Db, type Queryable, type User } from "./db.js";
import { helperScript } from "./policy.js";
import { AwsProvider, validateAwsTemplate, type MachineState, type WorkspaceProvider } from "./providers/aws.js";
import { HttpError } from "./service.js";
import { walletFor } from "./wallet.js";

/**
 * Cloud workspaces: developer machines in the customer's own cloud account, started from
 * admin-defined templates, stopped automatically after a set number of hours, and charged
 * to the same budget wallet as AI tools (running hours plus disk storage).
 */

export interface WorkspaceTemplate {
  id: number;
  name: string;
  provider: string;
  config: string;
  /** Price per running hour in 1/10,000 USD, so $0.1664 is 1664. */
  hourly_usd_e4: number;
  storage_gb_month_cents: number;
  stop_after_hours: number;
  enabled: number;
}

export interface Workspace {
  id: number;
  user_id: number;
  template_id: number;
  name: string;
  provider: string;
  machine_id: string | null;
  state: "creating" | MachineState | "error";
  detail: string | null;
  disk_gb: number;
  hourly_usd_e4: number;
  storage_gb_month_cents: number;
  stop_at: string | null;
  created_at: string;
  terminated_at: string | null;
}

const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]{40,}( [\w.@+-]{0,100})?$/;
const MAX_EXTEND_HOURS = 12;

export function validateSshKey(raw: string): string {
  const key = raw.trim().replace(/\s+/g, " ");
  if (!SSH_KEY_RE.test(key)) throw new HttpError(400, "That doesn't look like an SSH public key (ssh-ed25519 AAAA... or ssh-rsa AAAA...)");
  return key;
}

/** cloud-init script: a `dev` user with the developer's key, Claude Code, and Dev Hub's policy helper. */
export function userData(cfg: Config, user: User, sshKey: string): string {
  const env = [`DEVHUB_URL=${cfg.publicUrl}`, `DEVHUB_POLICY_TOKEN=${cfg.policyToken ?? ""}`, `DEVHUB_USER_EMAIL=${user.email}`].join("\n");
  return `#!/bin/bash
# Dev Hub workspace setup for ${user.email}. Expects an Ubuntu or Debian image with the SSM agent.
set -euo pipefail
id -u dev >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo dev
echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-dev && chmod 440 /etc/sudoers.d/90-dev
install -d -m 700 -o dev -g dev /home/dev/.ssh
cat > /home/dev/.ssh/authorized_keys <<'DEVHUB_KEY'
${sshKey}
DEVHUB_KEY
chown dev:dev /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys

# Dev Hub policy for Claude Code (managed settings come from the policy helper).
install -d /etc/devhub /etc/claude-code
cat > /etc/devhub/policy.env <<'DEVHUB_ENV'
${env}
DEVHUB_ENV
chmod 644 /etc/devhub/policy.env
cat > /usr/local/bin/devhub-policy <<'DEVHUB_HELPER'
${helperScript(cfg)}DEVHUB_HELPER
chmod 755 /usr/local/bin/devhub-policy
cat > /etc/claude-code/managed-settings.json <<'DEVHUB_SETTINGS'
{ "policyHelper": { "path": "/usr/local/bin/devhub-policy", "timeoutMs": 5000, "refreshIntervalMs": 900000 } }
DEVHUB_SETTINGS

# Tools: git, Node.js 22 and Claude Code.
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl ca-certificates
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
npm install -g @anthropic-ai/claude-code
`;
}

const overlapMs = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

export function periodBounds(period: string): [number, number] {
  const [y, m] = period.split("-").map(Number);
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
}

export class WorkspaceService {
  readonly provider: WorkspaceProvider | null;

  constructor(
    private db: Db,
    private cfg: Config,
    provider?: WorkspaceProvider | null,
    private now: () => number = Date.now,
  ) {
    this.provider = provider !== undefined ? provider : cfg.workspaces?.aws ? new AwsProvider(cfg.workspaces.aws.region) : null;
  }

  get enabled() {
    return this.provider !== null;
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  currentPeriod(): string {
    return this.iso().slice(0, 7);
  }

  /** Run a cloud call, turning its failure into a message the developer can act on. */
  private async cloud<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `Couldn't ${what}: ${(e as Error).message}`);
    }
  }

  private need(): WorkspaceProvider {
    if (!this.provider) throw new HttpError(400, "Workspaces aren't set up (configure workspaces.aws.region)");
    return this.provider;
  }

  // ------------------------------------------------------------------ templates

  async saveTemplate(id: number | null, b: Record<string, unknown>, actor: string): Promise<WorkspaceTemplate> {
    const name = String(b.name ?? "").trim();
    if (!/^[\w .,()+/-]{2,60}$/.test(name)) throw new HttpError(400, "name must be 2-60 characters: letters, digits, spaces and . , ( ) + / -");
    const config = validateAwsTemplate((b.config ?? {}) as Record<string, unknown>);
    const hourly = Number(b.hourly_usd);
    const storage = Number(b.storage_gb_month_usd ?? 0.08);
    const stopAfter = Number(b.stop_after_hours ?? 8);
    if (!Number.isFinite(hourly) || hourly < 0 || hourly > 100) throw new HttpError(400, "hourly_usd must be between 0 and 100");
    if (!Number.isFinite(storage) || storage < 0 || storage > 10) throw new HttpError(400, "storage_gb_month_usd must be between 0 and 10");
    if (!Number.isInteger(stopAfter) || stopAfter < 1 || stopAfter > 24) throw new HttpError(400, "stop_after_hours must be a whole number from 1 to 24");
    const enabled = b.enabled === false || b.enabled === "0" ? 0 : 1;
    // Hourly prices keep 4 decimals (AWS lists e.g. $0.1664), so they're stored in 1/10,000 USD.
    const values = [name, "aws", JSON.stringify(config), Math.round(hourly * 10_000), Math.round(storage * 100), stopAfter, enabled] as const;
    try {
      if (id === null) {
        id = await insertId(
          this.db,
          "INSERT INTO workspace_templates (name, provider, config, hourly_usd_e4, storage_gb_month_cents, stop_after_hours, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ...values,
        );
      } else {
        const r = await this.db.run(
          "UPDATE workspace_templates SET name = ?, provider = ?, config = ?, hourly_usd_e4 = ?, storage_gb_month_cents = ?, stop_after_hours = ?, enabled = ? WHERE id = ?",
          ...values,
          id,
        );
        if (r.changes === 0) throw new HttpError(404, "template not found");
      }
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new HttpError(409, `a template named ${name} already exists`);
      }
      throw e;
    }
    await audit(this.db, actor, "workspace.template.saved", { id, name, config, hourly_usd: hourly, stopAfter, enabled });
    return (await this.db.get<WorkspaceTemplate>("SELECT * FROM workspace_templates WHERE id = ?", id))!;
  }

  templates(onlyEnabled = false) {
    return this.db.all<WorkspaceTemplate>(`SELECT * FROM workspace_templates ${onlyEnabled ? "WHERE enabled = 1" : ""} ORDER BY name`);
  }

  // ------------------------------------------------------------------ lifecycle

  async get(id: number): Promise<Workspace> {
    const ws = await this.db.get<Workspace>("SELECT * FROM workspaces WHERE id = ?", id);
    if (!ws) throw new HttpError(404, "workspace not found");
    return ws;
  }

  listFor(userId: number) {
    return this.db.all<Workspace>("SELECT * FROM workspaces WHERE user_id = ? AND state != 'terminated' ORDER BY created_at", userId);
  }

  listAll() {
    return this.db.all<Workspace & { email: string; template: string }>(
      `SELECT w.*, u.email, t.name AS template FROM workspaces w JOIN users u ON u.id = w.user_id
       JOIN workspace_templates t ON t.id = w.template_id WHERE w.state != 'terminated' ORDER BY u.email, w.name`,
    );
  }

  private async budgetCheck(user: User) {
    const w = await walletFor(this.db, this.cfg, user);
    if (w.remainingCents <= 0) throw new HttpError(402, "Your AI budget for this month is used up, so workspaces can't be started. Ask for an increase.");
  }

  private async openRun(q: Queryable, ws: Workspace) {
    const open = await q.get("SELECT id FROM workspace_runs WHERE workspace_id = ? AND stopped_at IS NULL", ws.id);
    if (!open) {
      await q.run(
        "INSERT INTO workspace_runs (workspace_id, user_id, hourly_usd_e4, started_at) VALUES (?, ?, ?, ?)",
        ws.id,
        ws.user_id,
        ws.hourly_usd_e4,
        this.iso(),
      );
    }
  }

  private closeRun(q: Queryable, ws: Workspace) {
    return q.run("UPDATE workspace_runs SET stopped_at = ? WHERE workspace_id = ? AND stopped_at IS NULL", this.iso(), ws.id);
  }

  private setState(q: Queryable, ws: Workspace, state: Workspace["state"], extra: Record<string, string | number | null> = {}) {
    const sets: [string, string | number | null][] = [["state", state], ...Object.entries(extra)];
    return q.run(`UPDATE workspaces SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...sets.map(([, v]) => v), ws.id);
  }

  async create(user: User, templateId: number, name: string): Promise<Workspace> {
    const provider = this.need();
    name = name.trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new HttpError(400, "Name: 3-32 lowercase letters, digits or dashes, starting with a letter");
    const sshKey = await this.db.get<{ k: string | null }>("SELECT ssh_public_key AS k FROM users WHERE id = ?", user.id);
    if (!sshKey?.k) throw new HttpError(400, "Add your SSH public key first, so you can connect to the workspace.");
    const t = await this.db.get<WorkspaceTemplate>("SELECT * FROM workspace_templates WHERE id = ? AND enabled = 1", templateId);
    if (!t) throw new HttpError(400, "Choose an available template.");
    const mine = await this.listFor(user.id);
    const max = this.cfg.workspaces?.maxPerUser ?? 3;
    if (mine.length >= max) throw new HttpError(409, `You can have up to ${max} workspaces. Delete one first.`);
    if (mine.some((w) => w.name === name)) throw new HttpError(409, `You already have a workspace named ${name}.`);
    await this.budgetCheck(user);

    const disk = Number(JSON.parse(t.config).diskGb ?? 50);
    const id = await insertId(
      this.db,
      "INSERT INTO workspaces (user_id, template_id, name, provider, state, disk_gb, hourly_usd_e4, storage_gb_month_cents, created_at) VALUES (?, ?, ?, ?, 'creating', ?, ?, ?, ?)",
      user.id,
      t.id,
      name,
      t.provider,
      disk,
      t.hourly_usd_e4,
      t.storage_gb_month_cents,
      this.iso(),
    );
    let ws = await this.get(id);
    try {
      const machineId = await provider.create(JSON.parse(t.config), { workspaceId: id, name, ownerEmail: user.email, userData: userData(this.cfg, user, sshKey.k) });
      await this.db.tx(async (q) => {
        await this.setState(q, ws, "starting", { machine_id: machineId, stop_at: this.iso(this.now() + t.stop_after_hours * 3_600_000), detail: null });
        await this.openRun(q, ws);
      });
    } catch (e) {
      await this.setState(this.db, ws, "error", { detail: String((e as Error).message).slice(0, 300), terminated_at: this.iso() });
      await audit(this.db, user.email, "workspace.create_failed", { id, error: (e as Error).message });
      throw new HttpError(502, `The cloud provider refused to create the workspace: ${(e as Error).message}`);
    }
    await audit(this.db, user.email, "workspace.created", { id, name, template: t.name });
    ws = await this.get(id);
    return ws;
  }

  async start(user: User, ws: Workspace, actor = user.email) {
    if (ws.state !== "stopped") throw new HttpError(409, `The workspace is ${ws.state}; only a stopped workspace can be started.`);
    await this.budgetCheck(user);
    const t = await this.db.get<WorkspaceTemplate>("SELECT * FROM workspace_templates WHERE id = ?", ws.template_id);
    const provider = this.need();
    await this.cloud("start the workspace", () => provider.start(ws.machine_id!));
    await this.db.tx(async (q) => {
      await this.setState(q, ws, "starting", { stop_at: this.iso(this.now() + (t?.stop_after_hours ?? 8) * 3_600_000) });
      await this.openRun(q, ws);
    });
    await audit(this.db, actor, "workspace.started", { id: ws.id });
  }

  async stop(ws: Workspace, actor: string, reason = "workspace.stopped") {
    if (!["running", "starting"].includes(ws.state)) throw new HttpError(409, `The workspace is ${ws.state}; only a running workspace can be stopped.`);
    const provider = this.need();
    await this.cloud("stop the workspace", () => provider.stop(ws.machine_id!));
    await this.db.tx(async (q) => {
      await this.setState(q, ws, "stopping", { stop_at: null });
      await this.closeRun(q, ws);
    });
    await audit(this.db, actor, reason, { id: ws.id });
  }

  async extend(ws: Workspace, actor: string, hours = 2) {
    if (ws.state !== "running" && ws.state !== "starting") throw new HttpError(409, "Only a running workspace can be kept running longer.");
    const now = this.now();
    const base = Math.max(now, ws.stop_at ? Date.parse(ws.stop_at) : now);
    const until = Math.min(base + hours * 3_600_000, now + MAX_EXTEND_HOURS * 3_600_000);
    await this.setState(this.db, ws, ws.state, { stop_at: this.iso(until) });
    await audit(this.db, actor, "workspace.extended", { id: ws.id, until: this.iso(until) });
    return this.iso(until);
  }

  async destroy(ws: Workspace, actor: string) {
    if (ws.state === "terminated") return;
    const provider = this.need();
    if (ws.machine_id) await this.cloud("delete the workspace", () => provider.destroy(ws.machine_id!));
    await this.db.tx(async (q) => {
      await this.setState(q, ws, "terminated", { stop_at: null, terminated_at: this.iso() });
      await this.closeRun(q, ws);
    });
    await audit(this.db, actor, "workspace.deleted", { id: ws.id });
  }

  /**
   * Bring Dev Hub in line with the cloud: record actual states, open or close billing runs,
   * and stop workspaces that are past their stop time. Runs on every sync.
   */
  async reconcile(): Promise<{ checked: number; autoStopped: number }> {
    if (!this.provider) return { checked: 0, autoStopped: 0 };
    const live = await this.db.all<Workspace>("SELECT * FROM workspaces WHERE state NOT IN ('terminated', 'error', 'creating') AND machine_id IS NOT NULL");
    if (!live.length) return { checked: 0, autoStopped: 0 };
    const states = await this.provider.describe(live.map((w) => w.machine_id!));
    let autoStopped = 0;
    for (const ws of live) {
      const actual = states.get(ws.machine_id!) ?? "terminated";
      await this.db.tx(async (q) => {
        if (actual !== ws.state) {
          await this.setState(q, ws, actual, actual === "terminated" ? { terminated_at: this.iso(), stop_at: null } : {});
        }
        if (actual === "running" || actual === "starting") await this.openRun(q, ws);
        else if (actual === "stopped" || actual === "terminated") await this.closeRun(q, ws);
      });
      if (actual === "running" && ws.stop_at && Date.parse(ws.stop_at) <= this.now()) {
        try {
          await this.stop({ ...ws, state: "running" }, "system", "workspace.autostopped");
          autoStopped++;
        } catch (e) {
          console.error(`auto-stop of workspace ${ws.id} failed:`, (e as Error).message);
        }
      }
    }
    return { checked: live.length, autoStopped };
  }

  /** Month-to-date workspace cost per user, in cents: running hours plus disk storage. */
  async monthlyCosts(period: string): Promise<Map<number, number>> {
    const [ps, pe] = periodBounds(period);
    const now = this.now();
    const end = Math.min(pe, now);
    const out = new Map<number, number>();
    const add = (uid: number, cents: number) => out.set(uid, (out.get(uid) ?? 0) + cents);

    const runs = await this.db.all<{ user_id: number; hourly_usd_e4: number; started_at: string; stopped_at: string | null }>(
      "SELECT user_id, hourly_usd_e4, started_at, stopped_at FROM workspace_runs WHERE started_at < ? AND (stopped_at IS NULL OR stopped_at > ?)",
      new Date(pe).toISOString(),
      new Date(ps).toISOString(),
    );
    for (const r of runs) {
      const ms = overlapMs(Date.parse(r.started_at), r.stopped_at ? Date.parse(r.stopped_at) : now, ps, end);
      add(Number(r.user_id), (ms / 3_600_000) * (Number(r.hourly_usd_e4) / 100));
    }
    const disks = await this.db.all<{ user_id: number; disk_gb: number; storage_gb_month_cents: number; created_at: string; terminated_at: string | null }>(
      "SELECT user_id, disk_gb, storage_gb_month_cents, created_at, terminated_at FROM workspaces WHERE machine_id IS NOT NULL AND created_at < ? AND (terminated_at IS NULL OR terminated_at > ?)",
      new Date(pe).toISOString(),
      new Date(ps).toISOString(),
    );
    for (const d of disks) {
      const ms = overlapMs(Date.parse(d.created_at), d.terminated_at ? Date.parse(d.terminated_at) : now, ps, end);
      add(Number(d.user_id), (ms / (pe - ps)) * Number(d.disk_gb) * Number(d.storage_gb_month_cents));
    }
    for (const [k, v] of out) out.set(k, Math.round(v));
    return out;
  }
}

/** Feeds workspace cost into the wallet like any other tool, after reconciling with the cloud. */
export class WorkspacesConnector implements Connector {
  tool = "workspaces";
  constructor(private svc: WorkspaceService) {}

  externalIdFor(user: User): string {
    return String(user.id);
  }

  async fetchMonthlySpend(): Promise<SpendRow[]> {
    await this.svc.reconcile();
    const costs = await this.svc.monthlyCosts(this.svc.currentPeriod());
    return [...costs].filter(([, c]) => c > 0).map(([uid, cents]) => ({ externalId: String(uid), cents }));
  }
}

