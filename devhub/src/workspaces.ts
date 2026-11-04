import { createHash, randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { Connector, SpendRow } from "./connectors/types.js";
import { audit, insertId, isUniqueViolation, type Db, type Queryable, type User } from "./db.js";
import { helperScript } from "./policy.js";
import { buildProviders, PROVIDER_LABELS, validateTemplateConfig, type MachineState, type WorkspaceProvider } from "./providers/index.js";
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
  /** Stop a running workspace after this many minutes without activity; 0 = never. */
  idle_minutes: number;
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
  idle_minutes: number;
  /** Last time anyone used it (agent heartbeat with activity, or the backend's own tracking). */
  last_active_at: string | null;
  /** Last heartbeat from Dev Hub's agent, active or not. Null means the agent has never reported. */
  last_heartbeat_at: string | null;
  agent_token_hash: string | null;
  /** Set when the owner's budget ran out while it was running: it stops at this time unless the budget is raised. */
  budget_stop_at: string | null;
}

const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]{40,}( [\w.@+-]{0,100})?$/;
const MAX_EXTEND_HOURS = 12;
/** 1-minute load average per CPU at or above this counts as activity (a build, tests, an agent working). */
const ACTIVE_LOAD_PER_CPU = 0.3;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function validateSshKey(raw: string): string {
  const key = raw.trim().replace(/\s+/g, " ");
  if (!SSH_KEY_RE.test(key)) throw new HttpError(400, "That doesn't look like an SSH public key (ssh-ed25519 AAAA... or ssh-rsa AAAA...)");
  return key;
}

/**
 * The activity agent: every minute it reports open SSH sessions (which is how VS Code
 * Remote-SSH, Session Manager and IAP tunnels all arrive) and CPU load to Dev Hub. Dev Hub
 * decides whether that counts as activity, and may answer with a warning to show logged-in users.
 */
const AGENT_SCRIPT = `#!/bin/sh
# Dev Hub activity agent. Reports to Dev Hub so idle workspaces can be stopped.
. /etc/devhub/agent.env
SSH=$(ss -Htn state established '( sport = :22 )' 2>/dev/null | wc -l)
LOAD=$(cut -d' ' -f1 /proc/loadavg)
CPUS=$(nproc 2>/dev/null || echo 1)
WARN=$(curl -fsS --max-time 10 -X POST "$DEVHUB_URL/api/workspaces/heartbeat" \\
  -H "authorization: Bearer $DEVHUB_AGENT_TOKEN" -H "content-type: application/json" \\
  -d "{\\"ssh\\":$SSH,\\"load1\\":$LOAD,\\"cpus\\":$CPUS}" 2>/dev/null) || exit 0
[ -n "$WARN" ] && wall "$WARN" 2>/dev/null
exit 0
`;

/** cloud-init script: a `dev` user with the developer's key, Claude Code, Dev Hub's policy helper and activity agent. */
export function userData(cfg: Config, user: User, sshKey: string, agentToken = ""): string {
  const env = [`DEVHUB_URL=${cfg.publicUrl}`, `DEVHUB_POLICY_TOKEN=${cfg.policyToken ?? ""}`, `DEVHUB_USER_EMAIL=${user.email}`].join("\n");
  return `#!/bin/bash
# Dev Hub workspace setup for ${user.email}. Expects an Ubuntu or Debian image with the SSM agent.
set -euo pipefail
# GCP runs startup scripts on every boot; only set up once.
[ -f /var/lib/devhub/setup-done ] && exit 0
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

# Activity agent (root-only token), run every minute by a systemd timer.
umask 077
cat > /etc/devhub/agent.env <<'DEVHUB_AGENT_ENV'
DEVHUB_URL=${cfg.publicUrl}
DEVHUB_AGENT_TOKEN=${agentToken}
DEVHUB_AGENT_ENV
umask 022
cat > /usr/local/bin/devhub-agent <<'DEVHUB_AGENT'
${AGENT_SCRIPT}DEVHUB_AGENT
chmod 755 /usr/local/bin/devhub-agent
cat > /etc/systemd/system/devhub-agent.service <<'DEVHUB_UNIT'
[Unit]
Description=Dev Hub activity agent
[Service]
Type=oneshot
ExecStart=/usr/local/bin/devhub-agent
DEVHUB_UNIT
cat > /etc/systemd/system/devhub-agent.timer <<'DEVHUB_TIMER'
[Unit]
Description=Report workspace activity to Dev Hub every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
DEVHUB_TIMER
systemctl daemon-reload && systemctl enable --now devhub-agent.timer

# Tools: git, Node.js 22 and Claude Code.
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl ca-certificates
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
npm install -g @anthropic-ai/claude-code
install -d /var/lib/devhub && touch /var/lib/devhub/setup-done
`;
}

const overlapMs = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

export function periodBounds(period: string): [number, number] {
  const [y, m] = period.split("-").map(Number);
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
}

export class WorkspaceService {
  /** Configured backends by kind ("aws", "gcp", "coder"). Templates pick one. */
  readonly providers: Map<string, WorkspaceProvider>;

  constructor(
    private db: Db,
    private cfg: Config,
    providers?: WorkspaceProvider[],
    private now: () => number = Date.now,
  ) {
    this.providers = new Map((providers ?? buildProviders(cfg)).map((p) => [p.kind, p]));
    const grace = cfg.workspaces?.budgetGraceMinutes ?? 15;
    if (!Number.isInteger(grace) || grace < 0 || grace > 240) throw new Error("workspaces.budgetGraceMinutes must be a whole number from 0 to 240");
    this.budgetGraceMinutes = grace;
  }

  readonly budgetGraceMinutes: number;

  get enabled() {
    return this.providers.size > 0;
  }

  /** The SSH config block (or CLI steps) for reaching a workspace, if its backend is configured. */
  hintFor(w: Workspace): string | null {
    const p = this.providers.get(w.provider);
    return w.machine_id && p ? p.connectHint(w.machine_id, w.name) : null;
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

  private need(kind: string): WorkspaceProvider {
    const p = this.providers.get(kind);
    if (!p) throw new HttpError(400, `The ${PROVIDER_LABELS[kind] ?? kind} backend isn't configured on this Dev Hub.`);
    return p;
  }

  // ------------------------------------------------------------------ templates

  async saveTemplate(id: number | null, b: Record<string, unknown>, actor: string): Promise<WorkspaceTemplate> {
    const name = String(b.name ?? "").trim();
    if (!/^[\w .,()+/-]{2,60}$/.test(name)) throw new HttpError(400, "name must be 2-60 characters: letters, digits, spaces and . , ( ) + / -");
    // With a single backend configured, templates default to it.
    const kind = String(b.provider ?? (this.providers.size === 1 ? [...this.providers.keys()][0] : "")).trim();
    if (!kind) throw new HttpError(400, `provider is required: one of ${[...this.providers.keys()].join(", ")}`);
    this.need(kind);
    const config = validateTemplateConfig(kind, (b.config ?? {}) as Record<string, unknown>);
    const hourly = Number(b.hourly_usd);
    const storage = Number(b.storage_gb_month_usd ?? 0.08);
    const stopAfter = Number(b.stop_after_hours ?? 8);
    if (!Number.isFinite(hourly) || hourly < 0 || hourly > 100) throw new HttpError(400, "hourly_usd must be between 0 and 100");
    if (!Number.isFinite(storage) || storage < 0 || storage > 10) throw new HttpError(400, "storage_gb_month_usd must be between 0 and 10");
    if (!Number.isInteger(stopAfter) || stopAfter < 1 || stopAfter > 24) throw new HttpError(400, "stop_after_hours must be a whole number from 1 to 24");
    const enabled = b.enabled === false || b.enabled === "0" ? 0 : 1;
    const idle = Number(b.idle_minutes ?? 30);
    if (!Number.isInteger(idle) || idle < 0 || idle > 480) throw new HttpError(400, "idle_minutes must be a whole number from 0 (never) to 480");
    if (idle > 0 && idle < 10) throw new HttpError(400, "idle_minutes must be 0 (never) or at least 10, so a short break doesn't stop a workspace");
    // Hourly prices keep 4 decimals (AWS lists e.g. $0.1664), so they're stored in 1/10,000 USD.
    const values = [name, kind, JSON.stringify(config), Math.round(hourly * 10_000), Math.round(storage * 100), stopAfter, enabled, idle] as const;
    try {
      if (id === null) {
        id = await insertId(
          this.db,
          "INSERT INTO workspace_templates (name, provider, config, hourly_usd_e4, storage_gb_month_cents, stop_after_hours, enabled, idle_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ...values,
        );
      } else {
        const r = await this.db.run(
          "UPDATE workspace_templates SET name = ?, provider = ?, config = ?, hourly_usd_e4 = ?, storage_gb_month_cents = ?, stop_after_hours = ?, enabled = ?, idle_minutes = ? WHERE id = ?",
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
    await audit(this.db, actor, "workspace.template.saved", { id, name, provider: kind, config, hourly_usd: hourly, stopAfter, enabled, idleMinutes: idle });
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
      // A fresh start counts as activity, so the idle clock gives a full window from here.
      await q.run("UPDATE workspaces SET last_active_at = ? WHERE id = ?", this.iso(), ws.id);
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
    name = name.trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new HttpError(400, "Name: 3-32 lowercase letters, digits or dashes, starting with a letter");
    const t = await this.db.get<WorkspaceTemplate>("SELECT * FROM workspace_templates WHERE id = ? AND enabled = 1", templateId);
    if (!t) throw new HttpError(400, "Choose an available template.");
    const provider = this.need(t.provider);
    // Dev Hub's setup script installs the developer's key; Coder templates handle access themselves.
    const sshKey = await this.db.get<{ k: string | null }>("SELECT ssh_public_key AS k FROM users WHERE id = ?", user.id);
    if (provider.usesSetupScript && !sshKey?.k) throw new HttpError(400, "Add your SSH public key first, so you can connect to the workspace.");
    const mine = await this.listFor(user.id);
    const max = this.cfg.workspaces?.maxPerUser ?? 3;
    if (mine.length >= max) throw new HttpError(409, `You can have up to ${max} workspaces. Delete one first.`);
    if (mine.some((w) => w.name === name)) throw new HttpError(409, `You already have a workspace named ${name}.`);
    await this.budgetCheck(user);

    const disk = Number(JSON.parse(t.config).diskGb ?? 0);
    // Each machine gets its own token for the activity agent; only its hash is stored.
    const agentToken = provider.usesSetupScript ? randomBytes(32).toString("base64url") : null;
    const id = await insertId(
      this.db,
      "INSERT INTO workspaces (user_id, template_id, name, provider, state, disk_gb, hourly_usd_e4, storage_gb_month_cents, created_at, idle_minutes, agent_token_hash) VALUES (?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?)",
      user.id,
      t.id,
      name,
      t.provider,
      disk,
      t.hourly_usd_e4,
      t.storage_gb_month_cents,
      this.iso(),
      t.idle_minutes,
      agentToken ? sha256(agentToken) : null,
    );
    let ws = await this.get(id);
    try {
      const setup = provider.usesSetupScript ? userData(this.cfg, user, sshKey!.k!, agentToken!) : "";
      const machineId = await provider.create(JSON.parse(t.config), { workspaceId: id, name, ownerEmail: user.email, userData: setup });
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
    const provider = this.need(ws.provider);
    await this.cloud("start the workspace", () => provider.start(ws.machine_id!));
    await this.db.tx(async (q) => {
      await this.setState(q, ws, "starting", { stop_at: this.iso(this.now() + (t?.stop_after_hours ?? 8) * 3_600_000), detail: null });
      await this.openRun(q, ws);
    });
    await audit(this.db, actor, "workspace.started", { id: ws.id });
  }

  async stop(ws: Workspace, actor: string, reason = "workspace.stopped", detail: string | null = null) {
    if (!["running", "starting"].includes(ws.state)) throw new HttpError(409, `The workspace is ${ws.state}; only a running workspace can be stopped.`);
    const provider = this.need(ws.provider);
    await this.cloud("stop the workspace", () => provider.stop(ws.machine_id!));
    await this.db.tx(async (q) => {
      await this.setState(q, ws, "stopping", { stop_at: null, budget_stop_at: null, detail });
      await this.closeRun(q, ws);
    });
    await audit(this.db, actor, reason, { id: ws.id });
  }

  async extend(ws: Workspace, actor: string, hours = 2) {
    if (ws.state !== "running" && ws.state !== "starting") throw new HttpError(409, "Only a running workspace can be kept running longer.");
    if (ws.budget_stop_at) throw new HttpError(402, "Your AI budget for this month is used up, so this workspace will stop. Ask for an increase to keep it running.");
    const now = this.now();
    const base = Math.max(now, ws.stop_at ? Date.parse(ws.stop_at) : now);
    const until = Math.min(base + hours * 3_600_000, now + MAX_EXTEND_HOURS * 3_600_000);
    await this.setState(this.db, ws, ws.state, { stop_at: this.iso(until) });
    // Asking to keep it running counts as activity, so the idle clock restarts too.
    await this.db.run("UPDATE workspaces SET last_active_at = ? WHERE id = ?", this.iso(now), ws.id);
    await audit(this.db, actor, "workspace.extended", { id: ws.id, until: this.iso(until) });
    return this.iso(until);
  }

  async destroy(ws: Workspace, actor: string) {
    if (ws.state === "terminated") return;
    if (ws.machine_id) {
      const provider = this.need(ws.provider);
      await this.cloud("delete the workspace", () => provider.destroy(ws.machine_id!));
    }
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
    const all = await this.db.all<Workspace>("SELECT * FROM workspaces WHERE state NOT IN ('terminated', 'error', 'creating') AND machine_id IS NOT NULL");
    // A workspace whose backend is no longer configured can't be checked; leave it as it is
    // rather than wrongly marking it deleted.
    const live = all.filter((w) => this.providers.has(w.provider));
    if (!live.length) return { checked: 0, autoStopped: 0 };
    const states = new Map<string, MachineState>();
    for (const [kind, provider] of this.providers) {
      const ids = live.filter((w) => w.provider === kind).map((w) => w.machine_id!);
      if (ids.length) for (const [id, s] of await provider.describe(ids)) states.set(`${kind}:${id}`, s);
    }
    let autoStopped = 0;
    for (const ws of live) {
      const actual = states.get(`${ws.provider}:${ws.machine_id}`) ?? "terminated";
      await this.db.tx(async (q) => {
        if (actual !== ws.state) {
          await this.setState(q, ws, actual, actual === "terminated" ? { terminated_at: this.iso(), stop_at: null } : {});
        }
        if (actual === "running" || actual === "starting") await this.openRun(q, ws);
        else if (actual === "stopped" || actual === "terminated") await this.closeRun(q, ws);
      });
      if (actual !== "running") continue;

      // Backends that track activity themselves (Coder) feed the same idle clock.
      let cur = await this.get(ws.id);
      const seen = this.providers.get(ws.provider)!.lastActiveAt?.(ws.machine_id!);
      if (seen && (!cur.last_active_at || seen > cur.last_active_at)) {
        await this.db.run("UPDATE workspaces SET last_active_at = ? WHERE id = ?", seen, ws.id);
        cur = { ...cur, last_active_at: seen };
      }

      let stopWith: [string, string] | null = null;
      if (cur.stop_at && Date.parse(cur.stop_at) <= this.now()) {
        stopWith = ["workspace.autostopped", "Stopped at its scheduled time."];
      } else if (this.idleStopDue(cur, seen !== undefined)) {
        stopWith = ["workspace.idle_stopped", `Stopped after ${cur.idle_minutes} minutes without activity.`];
      }
      if (stopWith) {
        try {
          await this.stop({ ...cur, state: "running" }, "system", stopWith[0], stopWith[1]);
          autoStopped++;
        } catch (e) {
          console.error(`auto-stop of workspace ${ws.id} failed:`, (e as Error).message);
        }
      }
    }
    return { checked: live.length, autoStopped };
  }

  /**
   * Stop running workspaces whose owner's AI budget is used up. Each gets budgetGraceMinutes'
   * notice first (the agent warns logged-in users); if the budget is raised in the meantime,
   * the stop is cancelled. Workspaces of people who were deactivated stop straight away.
   * Workspace costs are counted live, not as of the last sync.
   */
  async enforceBudgets(onlyUserIds?: number[]): Promise<{ scheduled: number; stopped: number; cancelled: number }> {
    const out = { scheduled: 0, stopped: 0, cancelled: 0 };
    if (this.cfg.workspaces?.stopWhenBudgetUsedUp === false || !this.enabled) return out;
    const running = (await this.db.all<Workspace>("SELECT * FROM workspaces WHERE state IN ('running', 'starting') AND machine_id IS NOT NULL")).filter(
      (w) => this.providers.has(w.provider) && (!onlyUserIds || onlyUserIds.includes(w.user_id)),
    );
    if (!running.length) return out;
    const costs = await this.monthlyCosts(this.currentPeriod());
    const owners = new Map<number, { gone: boolean; usedUp: boolean }>();
    for (const uid of new Set(running.map((w) => w.user_id))) {
      const u = await this.db.get<User>("SELECT * FROM users WHERE id = ?", uid);
      if (!u || u.status !== "active" || u.deleted_at) {
        owners.set(uid, { gone: true, usedUp: true });
        continue;
      }
      const w = await walletFor(this.db, this.cfg, u);
      // Running time since the last sync isn't in the wallet yet.
      const unsynced = Math.max(0, (costs.get(uid) ?? 0) - (w.spendByTool.workspaces ?? 0));
      owners.set(uid, { gone: false, usedUp: w.remainingCents - unsynced <= 0 });
    }

    for (const ws of running) {
      const o = owners.get(ws.user_id)!;
      if (!o.usedUp) {
        if (ws.budget_stop_at) {
          await this.db.run("UPDATE workspaces SET budget_stop_at = NULL WHERE id = ?", ws.id);
          await audit(this.db, "system", "workspace.budget_stop_cancelled", { id: ws.id });
          out.cancelled++;
        }
        continue;
      }
      let at = ws.budget_stop_at;
      if (!at && !o.gone) {
        at = this.iso(this.now() + this.budgetGraceMinutes * 60_000);
        await this.db.run("UPDATE workspaces SET budget_stop_at = ? WHERE id = ?", at, ws.id);
        await audit(this.db, "system", "workspace.budget_stop_scheduled", { id: ws.id, at });
        out.scheduled++;
      }
      if (o.gone || Date.parse(at!) <= this.now()) {
        const detail = o.gone ? "Stopped because its owner no longer has access to Dev Hub." : "Stopped because the AI budget for this month is used up.";
        try {
          await this.stop(ws, "system", "workspace.budget_stopped", detail);
          out.stopped++;
        } catch (e) {
          console.error(`budget stop of workspace ${ws.id} failed:`, (e as Error).message);
        }
      }
    }
    return out;
  }

  /** When an idle workspace will be stopped, or null if idle stopping doesn't apply to it. */
  idleStopAt(w: Workspace): number | null {
    if (!w.idle_minutes || !w.last_active_at) return null;
    return Date.parse(w.last_active_at) + w.idle_minutes * 60_000;
  }

  /**
   * Idle-stop only on evidence: Dev Hub's agent has reported at least once, or the backend
   * tracks activity. A machine whose agent never reports falls back to the scheduled stop,
   * so a broken agent can't cut someone off mid-session.
   */
  private idleStopDue(w: Workspace, backendTracksActivity: boolean): boolean {
    const at = this.idleStopAt(w);
    if (at === null) return false;
    if (!w.last_heartbeat_at && !backendTracksActivity) return false;
    return at <= this.now();
  }

  /**
   * A heartbeat from a workspace's activity agent. Open SSH sessions or real CPU load count as
   * activity. Returns a warning for the agent to show logged-in users, or "" for none.
   */
  async heartbeat(token: string, b: Record<string, unknown>): Promise<string> {
    if (!token) throw new HttpError(401, "agent token required");
    const ws = await this.db.get<Workspace>(
      "SELECT * FROM workspaces WHERE agent_token_hash = ? AND state NOT IN ('terminated', 'error')",
      sha256(token),
    );
    if (!ws) throw new HttpError(401, "unknown agent token");
    const num = (v: unknown, max: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
    };
    const ssh = num(b.ssh, 10_000);
    const load = num(b.load1, 10_000);
    const cpus = Math.max(1, num(b.cpus, 1024));
    const active = ssh > 0 || load / cpus >= ACTIVE_LOAD_PER_CPU;
    const now = this.iso();
    await this.db.run(
      `UPDATE workspaces SET last_heartbeat_at = ?${active ? ", last_active_at = ?" : ""} WHERE id = ?`,
      ...(active ? [now, now, ws.id] : [now, ws.id]),
    );
    if (ws.state !== "running" && ws.state !== "starting") return "";

    // Warn before a budget stop (when it's scheduled, then at 10, 5 and 1 minutes), at 15, 5 and 1
    // minutes before a scheduled stop, and at 5 and 1 minutes before an idle stop.
    const minsLeft = (at: number) => Math.ceil((at - this.now()) / 60_000);
    if (ws.budget_stop_at) {
      const m = minsLeft(Date.parse(ws.budget_stop_at));
      if (m > 0 && [this.budgetGraceMinutes, 10, 5, 1].includes(m)) {
        return `Dev Hub: your AI budget for this month is used up, so this workspace stops in ${m} minute${m === 1 ? "" : "s"}. Save your work, or ask for an increase: ${this.cfg.publicUrl}/`;
      }
      return "";
    }
    if (ws.stop_at) {
      const m = minsLeft(Date.parse(ws.stop_at));
      if ([15, 5, 1].includes(m)) {
        return `Dev Hub: this workspace stops in ${m} minute${m === 1 ? "" : "s"} (${ws.stop_at.slice(11, 16)} UTC). Keep it running from the Workspaces page: ${this.cfg.publicUrl}/workspaces`;
      }
    }
    const idleAt = active ? null : this.idleStopAt(ws);
    if (idleAt !== null) {
      const m = minsLeft(idleAt);
      if ([5, 1].includes(m)) {
        return `Dev Hub: no activity on this workspace for a while; it stops in ${m} minute${m === 1 ? "" : "s"} unless it's used.`;
      }
    }
    return "";
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

